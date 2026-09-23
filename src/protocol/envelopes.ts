import { z } from "zod";

import { errorCodeSchema } from "../errors/codes.js";
import { requestIdSchema } from "../internal/schemas.js";
import { protocolVersionSchema } from "./constants.js";
import { actorSchema, jsonValueSchema } from "./models.js";
import { operationInputSchemas } from "./operations.js";

export const requestHeadersSchema = z.strictObject({
  version: protocolVersionSchema,
  keyId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  timestamp: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,15})$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
  requestId: requestIdSchema,
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

const requestShape = { actor: actorSchema.optional() };

export const controlRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...requestShape,
    operation: z.literal("system.capabilities"),
    input: operationInputSchemas["system.capabilities"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.create"),
    input: operationInputSchemas["users.create"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.search"),
    input: operationInputSchemas["users.search"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.get"),
    input: operationInputSchemas["users.get"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.ban"),
    input: operationInputSchemas["users.ban"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.unban"),
    input: operationInputSchemas["users.unban"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("users.revokeSessions"),
    input: operationInputSchemas["users.revokeSessions"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("subscriptions.get"),
    input: operationInputSchemas["subscriptions.get"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("subscriptions.changePlan"),
    input: operationInputSchemas["subscriptions.changePlan"],
  }),
  z.strictObject({
    ...requestShape,
    operation: z.literal("actions.invoke"),
    input: operationInputSchemas["actions.invoke"],
  }),
]);

export const controlSuccessResponseSchema = z.strictObject({
  ok: z.literal(true),
  requestId: requestIdSchema,
  data: jsonValueSchema,
});

export const controlErrorResponseSchema = z.strictObject({
  ok: z.literal(false),
  requestId: requestIdSchema,
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1).max(512).regex(/\S/),
  }),
});

export const controlResponseSchema = z.discriminatedUnion("ok", [
  controlSuccessResponseSchema,
  controlErrorResponseSchema,
]);

export type RequestHeaders = z.infer<typeof requestHeadersSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlSuccessResponse = z.infer<
  typeof controlSuccessResponseSchema
>;
export type ControlErrorResponse = z.infer<typeof controlErrorResponseSchema>;
export type ControlResponse = z.infer<typeof controlResponseSchema>;
