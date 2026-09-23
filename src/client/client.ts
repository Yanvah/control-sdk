import { randomUUID } from "node:crypto";
import { z } from "zod";

import { errorDetails } from "../errors/responses.js";
import { CONTROL_HEADERS, operationNameSchema } from "../protocol/constants.js";
import type { OperationName, ProtocolVersion } from "../protocol/constants.js";
import {
  controlRequestSchema,
  controlResponseSchema,
} from "../protocol/envelopes.js";
import type { ControlRequest } from "../protocol/envelopes.js";
import type { Capabilities } from "../protocol/models.js";
import { operationResultSchemas } from "../protocol/operations.js";
import type {
  OperationInput,
  OperationResult,
} from "../protocol/operations.js";
import { signRequest } from "../security/signature.js";
import { readResponseBody } from "./body.js";
import { invokeOptionsSchema, validateClientOptions } from "./config.js";
import { ControlClientError } from "./errors.js";
import type {
  ControlClient,
  ControlClientOptions,
  ControlInvokeOptions,
} from "./types.js";

const responseSchema = z.instanceof(Response);
const contentTypeSchema = z
  .string()
  .regex(/^application\/json(?:\s*;\s*charset=utf-8)?$/i);
const resultSchemas: {
  [Name in OperationName]: z.ZodType<OperationResult<Name>>;
} = operationResultSchemas;

function matchesRequest(
  request: ControlRequest,
  data: unknown,
  protocolVersion: ProtocolVersion,
): boolean {
  switch (request.operation) {
    case "system.capabilities":
      return (
        operationResultSchemas["system.capabilities"].parse(data)
          .protocolVersion === protocolVersion
      );
    case "users.search": {
      const result = operationResultSchemas["users.search"].parse(data);
      return result.users.length <= (request.input.limit ?? 20);
    }
    case "users.get": {
      const result = operationResultSchemas["users.get"].parse(data);
      return result.user === null || result.user.id === request.input.userId;
    }
    case "subscriptions.get": {
      const result = operationResultSchemas["subscriptions.get"].parse(data);
      return (
        result.subscription === null ||
        result.subscription.userId === request.input.userId
      );
    }
    default:
      return true;
  }
}

/** Creates a signed client. Calls never retry automatically, including mutations. */
export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  const configuration = validateClientOptions(options);
  const transport = configuration.fetch ?? globalThis.fetch;

  async function invoke<Name extends OperationName>(
    operationName: Name,
    input: OperationInput<NoInfer<Name>>,
    options: ControlInvokeOptions = {},
  ): Promise<OperationResult<Name>> {
    const requestId = randomUUID();
    const deadline = performance.now() + configuration.timeoutMs;
    let callOptions: z.output<typeof invokeOptionsSchema>;
    try {
      callOptions = invokeOptionsSchema.parse(options);
    } catch {
      throw new ControlClientError("INVALID_INPUT", requestId);
    }
    const controller = new AbortController();
    let cancellationCode: "REQUEST_TIMEOUT" | "REQUEST_ABORTED" | undefined;
    function cancel(code: "REQUEST_TIMEOUT" | "REQUEST_ABORTED"): void {
      if (cancellationCode !== undefined) return;
      cancellationCode = code;
      controller.abort();
    }
    function checkDeadline(): void {
      if (performance.now() >= deadline) cancel("REQUEST_TIMEOUT");
      if (cancellationCode !== undefined) {
        throw new ControlClientError(cancellationCode, requestId);
      }
    }

    let cancellationListener: (() => void) | undefined;
    const canceled = new Promise<never>((_resolve, reject) => {
      cancellationListener = (): void => {
        reject(
          new ControlClientError(
            cancellationCode ?? "REQUEST_TIMEOUT",
            requestId,
          ),
        );
      };
      controller.signal.addEventListener("abort", cancellationListener, {
        once: true,
      });
    });
    const timeout = setTimeout(
      () => cancel("REQUEST_TIMEOUT"),
      configuration.timeoutMs,
    );
    const abort = (): void => cancel("REQUEST_ABORTED");
    callOptions.signal?.addEventListener("abort", abort, { once: true });
    if (callOptions.signal?.aborted) abort();

    async function processRequest(): Promise<OperationResult<Name>> {
      checkDeadline();
      if (!operationNameSchema.safeParse(operationName).success) {
        throw new ControlClientError("OPERATION_UNSUPPORTED", requestId);
      }
      if (
        configuration.protocolVersion === "1" &&
        operationName === "users.create"
      )
        throw new ControlClientError("OPERATION_UNSUPPORTED", requestId);
      let payload: ControlRequest;
      let body: Uint8Array<ArrayBuffer>;
      try {
        payload = controlRequestSchema.parse({
          operation: operationName,
          ...(callOptions.actor === undefined
            ? {}
            : { actor: callOptions.actor }),
          input,
        });
        body = new TextEncoder().encode(JSON.stringify(payload));
      } catch {
        checkDeadline();
        throw new ControlClientError("INVALID_INPUT", requestId);
      }
      checkDeadline();
      const fields = {
        version: configuration.protocolVersion,
        keyId: configuration.keyId,
        timestamp: String(Date.now()),
        requestId,
        method: "POST",
        pathname: new URL(configuration.endpoint).pathname,
      };
      // Sign and send one byte buffer; reserializing would change authenticated content.
      const request = new Request(configuration.endpoint, {
        method: fields.method,
        headers: {
          "Content-Type": "application/json",
          [CONTROL_HEADERS.version]: fields.version,
          [CONTROL_HEADERS.keyId]: fields.keyId,
          [CONTROL_HEADERS.timestamp]: fields.timestamp,
          [CONTROL_HEADERS.requestId]: requestId,
          [CONTROL_HEADERS.signature]: signRequest(
            fields,
            body,
            configuration.secret,
          ),
        },
        body,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      let response: Response | undefined;
      try {
        let received: unknown;
        try {
          checkDeadline();
          received = await transport(request);
        } catch {
          checkDeadline();
          throw new ControlClientError("PRODUCT_UNAVAILABLE", requestId);
        }
        const parsedResponse = responseSchema.safeParse(received);
        if (!parsedResponse.success) {
          checkDeadline();
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }
        response = parsedResponse.data;
        checkDeadline();
        if (
          response.redirected ||
          (response.url !== "" && response.url !== configuration.endpoint) ||
          !contentTypeSchema.safeParse(response.headers.get("content-type"))
            .success
        ) {
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }

        let envelope: z.output<typeof controlResponseSchema>;
        try {
          const bytes = await readResponseBody(
            response,
            configuration.maxResponseBytes,
            controller.signal,
            checkDeadline,
          );
          checkDeadline();
          if (bytes === null) throw new Error("Invalid response body.");
          const data: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          envelope = controlResponseSchema.parse(data);
        } catch {
          checkDeadline();
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }
        checkDeadline();
        if (envelope.requestId !== requestId) {
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }
        if (!envelope.ok) {
          if (response.status !== errorDetails[envelope.error.code].status) {
            throw new ControlClientError("INVALID_RESPONSE", requestId);
          }
          // Remote text and error causes may contain secrets; expose only our fixed message.
          throw new ControlClientError(envelope.error.code, requestId);
        }
        if (response.status !== 200) {
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }
        try {
          const result = resultSchemas[operationName].parse(envelope.data);
          if (!matchesRequest(payload, result, configuration.protocolVersion))
            throw new Error("Mismatched operation result.");
          checkDeadline();
          return result;
        } catch {
          checkDeadline();
          throw new ControlClientError("INVALID_RESPONSE", requestId);
        }
      } finally {
        // Also cleans up a late response from a transport that ignored cancellation.
        if (
          response?.body !== null &&
          response?.body !== undefined &&
          !response.body.locked
        ) {
          void response.body.cancel().catch(() => undefined);
        }
      }
    }

    try {
      const work = processRequest().catch((error: unknown) => {
        checkDeadline();
        if (error instanceof ControlClientError) throw error;
        throw new ControlClientError("INTERNAL_ERROR", requestId);
      });
      return await Promise.race([work, canceled]);
    } finally {
      clearTimeout(timeout);
      callOptions.signal?.removeEventListener("abort", abort);
      if (cancellationListener)
        controller.signal.removeEventListener("abort", cancellationListener);
    }
  }

  return {
    invoke,
    getCapabilities(options?: ControlInvokeOptions): Promise<Capabilities> {
      return invoke("system.capabilities", {}, options);
    },
  };
}
