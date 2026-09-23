import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createControlClient } from "@yanvah/control/client";
import { afterAll, beforeAll, expect, test } from "vitest";

import { runSmoke } from "../../examples/nextjs/scripts/flow.ts";

const exampleDirectory = fileURLToPath(
  new URL("../../examples/nextjs/", import.meta.url),
);
const require = createRequire(
  new URL("../../examples/nextjs/package.json", import.meta.url),
);
const credentials = {
  productA: { keyId: "e2e-product-a", secret: randomBytes(32).toString("hex") },
  productB: { keyId: "e2e-product-b", secret: randomBytes(32).toString("hex") },
};
let origin: string;
let fixtureDirectory: string | undefined;
let next: ChildProcess | undefined;
let exited = false;

async function unusedPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing test port.");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function stopNext(signal: NodeJS.Signals): void {
  if (next?.pid === undefined || exited) return;
  // Next dev owns a worker process; terminate only this test's process group.
  if (process.platform === "win32") next.kill(signal);
  else process.kill(-next.pid, signal);
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(
    fileURLToPath(new URL("../../examples/.nextjs-test-", import.meta.url)),
  );
  // Next generates declarations and edits tsconfig; keep those writes out of the example.
  for (const name of [
    "app",
    "lib",
    "config.ts",
    "next.config.mjs",
    "package.json",
    "tsconfig.json",
  ]) {
    await cp(join(exampleDirectory, name), join(fixtureDirectory, name), {
      recursive: true,
    });
  }
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  next = spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: fixtureDirectory,
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        PRODUCT_A_KEY_ID: credentials.productA.keyId,
        PRODUCT_A_SECRET: credentials.productA.secret,
        PRODUCT_B_KEY_ID: credentials.productB.keyId,
        PRODUCT_B_SECRET: credentials.productB.secret,
      },
    },
  );
  next.once("exit", () => {
    exited = true;
  });
  next.once("error", () => {
    exited = true;
  });
  const client = createControlClient({
    endpoint: `${origin}/api/yanvah-control`,
    ...credentials.productA,
    timeoutMs: 1_000,
  });
  const deadline = performance.now() + 60_000;
  while (!exited && performance.now() < deadline) {
    try {
      if ((await client.getCapabilities()).product.id === "product-a") return;
    } catch {
      // Requests can arrive while Next is still compiling the route.
    }
    await delay(100);
  }
  throw new Error("The isolated Next.js example did not become ready.");
}, 65_000);

afterAll(async () => {
  stopNext("SIGTERM");
  let deadline = performance.now() + 5_000;
  while (!exited && next !== undefined && performance.now() < deadline)
    await delay(50);
  if (!exited && next !== undefined) {
    stopNext("SIGKILL");
    deadline = performance.now() + 5_000;
    while (!exited && performance.now() < deadline) await delay(50);
  }
  if (!exited && next !== undefined)
    throw new Error("The isolated Next.js example did not stop.");
  if (fixtureDirectory !== undefined)
    await rm(fixtureDirectory, { recursive: true, force: true });
}, 15_000);

test("the real Next.js routes complete the two-product smoke flow and restore repeatable fixture state", async () => {
  const steps: string[] = [];
  const productA = createControlClient({
    endpoint: `${origin}/api/yanvah-control`,
    ...credentials.productA,
  });
  const productB = createControlClient({
    endpoint: `${origin}/api/secondary-control`,
    ...credentials.productB,
  });
  const originalA = await productA.invoke("users.get", { userId: "user_123" });
  const originalB = await productB.invoke("users.get", { userId: "user_123" });
  const originalPlanA = await productA.invoke("subscriptions.get", {
    userId: "user_123",
  });
  const originalPlanB = await productB.invoke("subscriptions.get", {
    userId: "user_123",
  });

  for (let iteration = 0; iteration < 2; iteration++) {
    await runSmoke({
      origin,
      ...credentials,
      onStep: (message) => {
        steps.push(message);
      },
    });
    expect(await productA.invoke("users.get", { userId: "user_123" })).toEqual(
      originalA,
    );
    expect(await productB.invoke("users.get", { userId: "user_123" })).toEqual(
      originalB,
    );
    expect(
      await productA.invoke("subscriptions.get", { userId: "user_123" }),
    ).toEqual(originalPlanA);
    expect(
      await productB.invoke("subscriptions.get", { userId: "user_123" }),
    ).toEqual(originalPlanB);
  }
  expect(steps).toHaveLength(26);
  expect(new Set(steps).size).toBe(13);
}, 60_000);

test.each([
  "https://example.com",
  "http://127.0.0.1:3001/api/yanvah-control",
  "http://user:password@127.0.0.1:3001",
  "http://127.0.0.1:3001?target=other",
  "http://127.0.0.1:3001#other",
])(
  "smoke refuses a non-local or ambiguous target: %s",
  async (unsafeOrigin) => {
    await expect(
      runSmoke({ origin: unsafeOrigin, ...credentials }),
    ).rejects.toThrow(
      "Smoke requires an http://127.0.0.1 origin without a path.",
    );
  },
);
