import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import type { TestContext } from "vitest";

import { createControlClient } from "../../src/client/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
} from "../../src/server/index.js";
import type { ControlHandler } from "../../src/server/index.js";
import { keyId, product, secret } from "../helpers/signed-request.js";

async function serve(
  context: TestContext,
  handler: ControlHandler,
  compress = false,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else value?.forEach((entry) => headers.append(name, entry));
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) {
        const bytes: unknown = chunk;
        if (!(bytes instanceof Uint8Array))
          throw new Error("Invalid HTTP body.");
        chunks.push(bytes);
      }
      const response = await handler(
        new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        }),
      );
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) =>
        outgoing.setHeader(name, value),
      );
      const body = new Uint8Array(await response.arrayBuffer());
      const bytes = compress ? gzipSync(body) : body;
      if (compress) outgoing.setHeader("content-encoding", "gzip");
      outgoing.setHeader("content-length", bytes.byteLength);
      outgoing.end(bytes);
    })().catch(() => {
      outgoing.statusCode = 500;
      outgoing.end();
    });
  });
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  context.onTestFinished(close);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test address.");
  return { endpoint: `http://127.0.0.1:${address.port}/api/control`, close };
}

test("platform fetch completes a signed round trip over HTTP", async (context) => {
  const handler = createControlHandler({
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
    users: { get: ({ userId }) => ({ id: userId }) },
  });
  const { endpoint } = await serve(context, handler);
  const client = createControlClient({ endpoint, keyId, secret });
  await expect(
    client.invoke("users.get", { userId: "user_123" }),
  ).resolves.toEqual({ user: { id: "user_123" } });
});

test("platform fetch decompresses responses and the limit applies to decoded bytes", async (context) => {
  const handler = createControlHandler({
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
    users: {
      search: () =>
        Array.from({ length: 20 }, (_, index) => ({
          id: String(index),
          name: "n".repeat(200),
        })),
    },
  });
  const { endpoint } = await serve(context, handler, true);
  const client = createControlClient({ endpoint, keyId, secret });
  expect(
    (await client.invoke("users.search", { query: "n" })).users,
  ).toHaveLength(20);
  const bounded = createControlClient({
    endpoint,
    keyId,
    secret,
    maxResponseBytes: 1024,
  });
  await expect(
    bounded.invoke("users.search", { query: "n" }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("platform fetch never follows a redirect carrying signed credentials", async (context) => {
  let redirectedRequests = 0;
  const target = await serve(context, () => {
    redirectedRequests++;
    return Promise.resolve(Response.json({}));
  });
  const { endpoint } = await serve(context, () =>
    Promise.resolve(Response.redirect(target.endpoint, 307)),
  );
  const client = createControlClient({ endpoint, keyId, secret });
  await expect(client.getCapabilities()).rejects.toMatchObject({
    code: "PRODUCT_UNAVAILABLE",
  });
  expect(redirectedRequests).toBe(0);
});

test("an offline endpoint fails with a sanitized product error", async (context) => {
  const { endpoint, close } = await serve(context, () =>
    Promise.resolve(Response.json({})),
  );
  await close();
  const client = createControlClient({
    endpoint,
    keyId,
    secret,
    timeoutMs: 1000,
  });
  await expect(client.getCapabilities()).rejects.toMatchObject({
    code: "PRODUCT_UNAVAILABLE",
    message: "The product is temporarily unavailable.",
  });
});
