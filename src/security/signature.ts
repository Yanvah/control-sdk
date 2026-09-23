import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SignedRequestFields {
  version: string;
  keyId: string;
  timestamp: string;
  requestId: string;
  method: string;
  pathname: string;
}

export function hashBody(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createCanonicalRequest(
  fields: SignedRequestFields,
  body: Uint8Array,
): string {
  // Preserve wire values and exact body bytes; normalization changes the signature.
  return [
    fields.version,
    fields.keyId,
    fields.timestamp,
    fields.requestId,
    fields.method,
    fields.pathname,
    hashBody(body),
  ].join("\n");
}

export function signRequest(
  fields: SignedRequestFields,
  body: Uint8Array,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(createCanonicalRequest(fields, body), "utf8")
    .digest("hex");
}

export function verifyRequestSignature(
  fields: SignedRequestFields,
  body: Uint8Array,
  secret: string,
  signature: string,
): boolean {
  if (signature.length !== 64 || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }

  const expected = Buffer.from(signRequest(fields, body, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, received);
}
