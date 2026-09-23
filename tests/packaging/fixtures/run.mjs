import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import console from "node:console";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";
import { promisify } from "node:util";
import { controlRequestSchema } from "@yanvah/control";
import { createControlClient } from "@yanvah/control/client";
import { POST, runtime } from "./build/route.js";

assert.equal(runtime, "nodejs");
assert.equal(
  controlRequestSchema.parse({ operation: "system.capabilities", input: {} })
    .operation,
  "system.capabilities",
);
await assert.rejects(import("@yanvah/control/security/signature"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
await assert.rejects(import("@yanvah/control/package.json"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new globalThis.Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      headers.append(
        incoming.rawHeaders[index],
        incoming.rawHeaders[index + 1],
      );
    }
    const response = await POST(
      new globalThis.Request(new URL(incoming.url, "http://127.0.0.1"), {
        method: incoming.method,
        headers,
        body: Buffer.concat(chunks),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end();
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/yanvah-control`;
  const client = createControlClient({
    endpoint,
    keyId: process.env.YANVAH_CONTROL_KEY_ID,
    secret: process.env.YANVAH_CONTROL_SECRET,
  });
  const metadata = JSON.parse(
    await readFile(
      new URL("./node_modules/@yanvah/control/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal((await client.getCapabilities()).sdkVersion, metadata.version);
  assert.deepEqual(await client.invoke("users.get", { userId: "user_123" }), {
    user: { id: "user_123", email: "john@example.com" },
  });
  assert.deepEqual(
    await client.invoke("actions.invoke", {
      actionId: "count-matches",
      input: { query: "john" },
    }),
    { count: 1 },
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["build/client.js"],
    {
      env: { ...process.env, PRODUCT_ENDPOINT: endpoint },
      timeout: 10_000,
    },
  );
  assert.equal(stdout.trim(), "Example SaaS 1");
  console.log("Packed README examples passed.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
