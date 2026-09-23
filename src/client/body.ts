import { z } from "zod";

const contentLengthSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

export async function readResponseBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
  checkDeadline: () => void,
): Promise<Uint8Array | null> {
  if (response.bodyUsed || response.body?.locked) return null;
  const encoding = response.headers.get("content-encoding");
  // Fetch exposes decompressed bytes; encoded Content-Length describes a different body.
  const declaredLength =
    encoding === null || encoding.toLowerCase() === "identity"
      ? response.headers.get("content-length")
      : null;
  if (
    declaredLength !== null &&
    (!contentLengthSchema.safeParse(declaredLength).success ||
      Number(declaredLength) > maxResponseBytes)
  ) {
    return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const body = new Uint8Array(maxResponseBytes);
  let byteLength = 0;
  let finished = false;
  const cancel = (): void => {
    // A custom stream's cancellation hook may hang or reject.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkDeadline();
      const chunk = await reader.read();
      checkDeadline();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (
        !(chunk.value instanceof Uint8Array) ||
        chunk.value.byteLength > maxResponseBytes - byteLength
      )
        return null;
      body.set(chunk.value, byteLength);
      byteLength += chunk.value.byteLength;
    }
    if (declaredLength !== null && byteLength !== Number(declaredLength))
      return null;
    return body.subarray(0, byteLength);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
