import type { OperationName, ProtocolVersion } from "../protocol/constants.js";
import type { Actor, Capabilities } from "../protocol/models.js";
import type {
  OperationInput,
  OperationResult,
} from "../protocol/operations.js";

export interface ControlClientOptions {
  /** HTTPS endpoint; HTTP is accepted only on loopback for local development. */
  endpoint: string;
  keyId: string;
  /** Independent connection secret, used as literal UTF-8 text (32–1024 bytes). */
  secret: string;
  /** Defaults to v1 for existing integrations. Creation requires v2. */
  protocolVersion?: ProtocolVersion;
  /** Deadline covering transport and response validation; default 10,000 ms, max 60,000. */
  timeoutMs?: number;
  /** Maximum decoded response bytes; default 1 MiB, maximum 10 MiB. */
  maxResponseBytes?: number;
  /** Optional trusted transport implementing the standard fetch contract. */
  fetch?: typeof globalThis.fetch;
}

export interface ControlInvokeOptions {
  /** Signed audit attribution, not independent authorization. */
  actor?: Actor;
  /** Cancels waiting; it cannot undo a mutation already received by the product. */
  signal?: AbortSignal;
}

export interface ControlClient {
  getCapabilities(options?: ControlInvokeOptions): Promise<Capabilities>;
  invoke<Name extends OperationName>(
    operationName: Name,
    input: OperationInput<NoInfer<Name>>,
    options?: ControlInvokeOptions,
  ): Promise<OperationResult<Name>>;
}
