import { randomUUID } from "node:crypto";
import { z } from "zod";

import { errorResponse } from "../errors/responses.js";
import { requestIdSchema } from "../internal/schemas.js";
import { CONTROL_HEADERS, operationNameSchema } from "../protocol/constants.js";
import type { ProtocolVersion } from "../protocol/constants.js";
import {
  controlRequestSchema,
  controlSuccessResponseSchema,
  requestHeadersSchema,
} from "../protocol/envelopes.js";
import { verifyRequestSignature } from "../security/signature.js";
import { isTimestampValid, replayExpiresAt } from "../security/timestamp.js";
import { readRequestBody } from "./body.js";
import { validateOptions } from "./config.js";
import { ControlHandlerError } from "./errors.js";
import { createCapabilities, invokeHandler } from "./routing.js";
import type { ControlHandler, ControlHandlerOptions } from "./types.js";

const requestSchema = z.instanceof(Request);
const operationEnvelopeSchema = z.object({ operation: z.string() });
const contentTypeSchema = z
  .string()
  .regex(/^application\/json(?:\s*;\s*charset=utf-8)?$/i);
const consumedSchema = z.boolean();

/** Creates a signed-request handler. Invalid configuration throws a sanitized TypeError. */
export function createControlHandler<
  ActionSchemas extends Record<string, unknown> = Record<string, unknown>,
>(options: ControlHandlerOptions<ActionSchemas>): ControlHandler {
  const configuration = validateOptions(options);
  const capabilities: Record<
    ProtocolVersion,
    ReturnType<typeof createCapabilities>
  > = {
    "1": createCapabilities(configuration, "1"),
    "2": createCapabilities(configuration, "2"),
  };
  const consume = configuration.replayStore.consume.bind(
    configuration.replayStore,
  );

  return async function controlHandler(request: Request): Promise<Response> {
    if (!requestSchema.safeParse(request).success) {
      return errorResponse(randomUUID(), "INVALID_INPUT");
    }
    const incomingId = requestIdSchema.safeParse(
      request.headers.get(CONTROL_HEADERS.requestId),
    );
    const requestId = incomingId.success ? incomingId.data : randomUUID();
    const controller = new AbortController();
    const deadline = performance.now() + configuration.requestTimeoutMs;
    const abort = (): void => controller.abort();
    const timeout = setTimeout(abort, configuration.requestTimeoutMs);
    request.signal.addEventListener("abort", abort, { once: true });

    let cancellationListener: (() => void) | undefined;
    const canceled = new Promise<Response>((resolve) => {
      cancellationListener = (): void => {
        resolve(errorResponse(requestId, "REQUEST_TIMEOUT"));
      };
      controller.signal.addEventListener("abort", cancellationListener, {
        once: true,
      });
    });
    if (request.signal.aborted) abort();

    function checkDeadline(): void {
      if (performance.now() >= deadline) abort();
      controller.signal.throwIfAborted();
    }

    async function processRequest(): Promise<Response> {
      checkDeadline();
      const headers = requestHeadersSchema.safeParse({
        version: request.headers.get(CONTROL_HEADERS.version),
        keyId: request.headers.get(CONTROL_HEADERS.keyId),
        timestamp: request.headers.get(CONTROL_HEADERS.timestamp),
        requestId: request.headers.get(CONTROL_HEADERS.requestId),
        signature: request.headers.get(CONTROL_HEADERS.signature),
      });
      if (!headers.success || headers.data.keyId !== configuration.auth.keyId) {
        return errorResponse(requestId, "AUTHENTICATION_FAILED");
      }
      const body = await readRequestBody(
        request,
        configuration.maxBodyBytes,
        controller.signal,
        deadline,
      );
      checkDeadline();
      if (body === null) return errorResponse(requestId, "INVALID_INPUT");

      const url = new URL(request.url);
      if (
        !verifyRequestSignature(
          {
            ...headers.data,
            method: request.method,
            pathname: url.pathname,
          },
          body,
          configuration.auth.secret,
          headers.data.signature,
        )
      ) {
        return errorResponse(requestId, "AUTHENTICATION_FAILED");
      }
      if (
        !isTimestampValid(
          headers.data.timestamp,
          Date.now(),
          configuration.timestampToleranceMs,
        )
      ) {
        return errorResponse(requestId, "REQUEST_EXPIRED");
      }

      let consumed: unknown;
      try {
        // Claim only authenticated IDs, retaining them through future clock skew.
        consumed = await consume(
          headers.data.requestId.toLowerCase(),
          replayExpiresAt(
            headers.data.timestamp,
            configuration.timestampToleranceMs,
          ),
        );
      } catch {
        checkDeadline();
        return errorResponse(requestId, "PRODUCT_UNAVAILABLE");
      }
      checkDeadline();
      if (!consumedSchema.safeParse(consumed).success) {
        return errorResponse(requestId, "PRODUCT_UNAVAILABLE");
      }
      if (consumed === false)
        return errorResponse(requestId, "REQUEST_REPLAYED");
      // A slow shared store must not authorize a request after its window closes.
      if (
        !isTimestampValid(
          headers.data.timestamp,
          Date.now(),
          configuration.timestampToleranceMs,
        )
      ) {
        return errorResponse(requestId, "REQUEST_EXPIRED");
      }
      if (request.method !== "POST")
        return errorResponse(requestId, "OPERATION_UNSUPPORTED");
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.href.includes("?") ||
        url.href.includes("#") ||
        !contentTypeSchema.safeParse(request.headers.get("content-type"))
          .success
      ) {
        return errorResponse(requestId, "INVALID_INPUT");
      }
      const encoding = request.headers.get("content-encoding");
      if (encoding !== null && encoding.toLowerCase() !== "identity") {
        return errorResponse(requestId, "INVALID_INPUT");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch {
        return errorResponse(requestId, "INVALID_INPUT");
      }
      const envelope = operationEnvelopeSchema.safeParse(payload);
      if (!envelope.success) return errorResponse(requestId, "INVALID_INPUT");
      const operation = operationNameSchema.safeParse(envelope.data.operation);
      if (
        !operation.success ||
        !capabilities[headers.data.version].operations.includes(operation.data)
      ) {
        return errorResponse(requestId, "OPERATION_UNSUPPORTED");
      }
      const parsed = controlRequestSchema.safeParse(payload);
      if (!parsed.success) return errorResponse(requestId, "INVALID_INPUT");

      checkDeadline();
      let invocation: Awaited<ReturnType<typeof invokeHandler>>;
      try {
        invocation =
          parsed.data.operation === "system.capabilities"
            ? { data: capabilities[headers.data.version] }
            : await invokeHandler(
                parsed.data,
                configuration,
                {
                  requestId,
                  actor: parsed.data.actor,
                  signal: controller.signal,
                },
                checkDeadline,
              );
      } catch (error) {
        checkDeadline();
        if (
          headers.data.version === "2" &&
          parsed.data.operation === "users.create" &&
          error instanceof ControlHandlerError &&
          error.code === "USER_ALREADY_EXISTS"
        )
          return errorResponse(requestId, error.code);
        throw error;
      }
      checkDeadline();
      if ("error" in invocation)
        return errorResponse(requestId, invocation.error);
      const response = controlSuccessResponseSchema.parse({
        ok: true,
        requestId,
        data: invocation.data,
      });
      const result = Response.json(response, {
        headers: { "Cache-Control": "no-store" },
      });
      checkDeadline();
      return result;
    }

    try {
      const work = processRequest().catch(() => {
        if (performance.now() >= deadline) abort();
        return errorResponse(
          requestId,
          controller.signal.aborted ? "REQUEST_TIMEOUT" : "INTERNAL_ERROR",
        );
      });
      return await Promise.race([work, canceled]);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      if (cancellationListener) {
        controller.signal.removeEventListener("abort", cancellationListener);
      }
      if (request.body !== null && !request.body.locked) {
        void request.body.cancel().catch(() => undefined);
      }
    }
  };
}
