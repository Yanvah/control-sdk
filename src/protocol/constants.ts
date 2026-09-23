import { z } from "zod";

/** Default client version. New operations are opt-in through an explicit version. */
export const PROTOCOL_VERSION = "1";
export const SUPPORTED_PROTOCOL_VERSIONS = ["1", "2"] as const;

export const CONTROL_HEADERS = {
  version: "X-Yanvah-Version",
  keyId: "X-Yanvah-Key-Id",
  timestamp: "X-Yanvah-Timestamp",
  requestId: "X-Yanvah-Request-Id",
  signature: "X-Yanvah-Signature",
} as const;

export const OPERATION_NAMES = [
  "system.capabilities",
  "users.create",
  "users.search",
  "users.get",
  "users.ban",
  "users.unban",
  "users.revokeSessions",
  "subscriptions.get",
  "subscriptions.changePlan",
  "actions.invoke",
] as const;

export const protocolVersionSchema = z.enum(SUPPORTED_PROTOCOL_VERSIONS);
export const operationNameSchema = z.enum(OPERATION_NAMES);
export const V1_OPERATION_NAMES = OPERATION_NAMES.filter(
  (name) => name !== "users.create",
);

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
export type OperationName = z.infer<typeof operationNameSchema>;
