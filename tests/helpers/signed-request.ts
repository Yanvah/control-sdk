import { createHash, createHmac } from "node:crypto";

export const now = 1_789_819_200_000;
export const requestId = "7a1aaed4-b884-4d9c-8148-c5c79be928c6";
export const secondRequestId = "8a1aaed4-b884-4d9c-8148-c5c79be928c6";
export const secret = "test-connection-secret-at-least-32-bytes";
export const keyId = "product-a-key";
export const product = { id: "product-a", name: "Product A" };

interface SignedRequestOptions {
  body?: string | Uint8Array;
  url?: string;
  method?: string;
  timestamp?: string;
  requestId?: string;
  version?: string;
  keyId?: string;
  secret?: string;
  signal?: AbortSignal;
}

// Deliberately independent of SDK signing so transport tests verify the contract.
export function signedRequest(options: SignedRequestOptions = {}): Request {
  const body =
    options.body ??
    JSON.stringify({
      operation: "users.search",
      input: { query: "john@example.com" },
    });
  const url = options.url ?? "https://product.example/api/yanvah-control";
  const method = options.method ?? "POST";
  const timestamp = options.timestamp ?? String(now);
  const id = options.requestId ?? requestId;
  const version = options.version ?? "1";
  const connectionKey = options.keyId ?? keyId;
  const canonical = [
    version,
    connectionKey,
    timestamp,
    id,
    method,
    new URL(url).pathname,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  const signature = createHmac("sha256", options.secret ?? secret)
    .update(canonical)
    .digest("hex");
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-yanvah-version": version,
      "x-yanvah-key-id": connectionKey,
      "x-yanvah-timestamp": timestamp,
      "x-yanvah-request-id": id,
      "x-yanvah-signature": signature,
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: typeof body === "string" ? body : new Uint8Array(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
