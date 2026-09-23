import { z } from "zod";

const contentLengthSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

export async function readRequestBody(
  request: Request,
  maxBodyBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<Uint8Array | null> {
  if (request.bodyUsed || request.body?.locked) return null;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!contentLengthSchema.safeParse(declaredLength).success ||
      Number(declaredLength) > maxBodyBytes)
  ) {
    return null;
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const body = new Uint8Array(maxBodyBytes);
  let byteLength = 0;
  let finished = false;
  const cancel = (): void => {
    // A stream's cancel hook can itself hang; rejection cleanup must not wait for it.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted && performance.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) return null;
      if (chunk.value.byteLength > maxBodyBytes - byteLength) return null;
      // Copy each chunk so a stream producer cannot alter bytes after receipt.
      body.set(chunk.value, byteLength);
      byteLength += chunk.value.byteLength;
    }
    if (
      signal.aborted ||
      performance.now() >= deadline ||
      (declaredLength !== null && byteLength !== Number(declaredLength))
    ) {
      return null;
    }
    return body.subarray(0, byteLength);
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
