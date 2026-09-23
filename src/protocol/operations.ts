import { z } from "zod";

import { actionIdSchema, identifierSchema } from "../internal/schemas.js";
import type { OperationName } from "./constants.js";
import {
  capabilitiesSchema,
  jsonValueSchema,
  subscriptionSchema,
  userSchema,
} from "./models.js";

const userIdInputSchema = z.strictObject({ userId: identifierSchema });

export const operationInputSchemas = {
  "system.capabilities": z.strictObject({}),
  "users.create": z.strictObject({
    email: z.email().max(254),
    name: z.string().min(1).max(200).regex(/\S/).optional(),
  }),
  "users.search": z.strictObject({
    query: z.string().min(1).max(256).regex(/\S/),
    limit: z.int().min(1).max(100).optional(),
  }),
  "users.get": userIdInputSchema,
  "users.ban": z.strictObject({
    userId: identifierSchema,
    reason: z.string().min(1).max(2000).regex(/\S/).optional(),
  }),
  "users.unban": userIdInputSchema,
  "users.revokeSessions": userIdInputSchema,
  "subscriptions.get": userIdInputSchema,
  "subscriptions.changePlan": z.strictObject({
    userId: identifierSchema,
    planId: identifierSchema,
  }),
  "actions.invoke": z.strictObject({
    actionId: actionIdSchema,
    input: jsonValueSchema,
  }),
} as const satisfies Record<OperationName, z.ZodType>;

export const operationResultSchemas = {
  "system.capabilities": capabilitiesSchema,
  "users.create": z.strictObject({ user: userSchema }),
  "users.search": z.strictObject({ users: z.array(userSchema).max(100) }),
  "users.get": z.strictObject({ user: userSchema.nullable() }),
  "users.ban": z.null(),
  "users.unban": z.null(),
  "users.revokeSessions": z.null(),
  "subscriptions.get": z.strictObject({
    subscription: subscriptionSchema.nullable(),
  }),
  "subscriptions.changePlan": z.null(),
  "actions.invoke": jsonValueSchema,
} as const satisfies Record<OperationName, z.ZodType>;

export type OperationInput<Name extends OperationName> = z.infer<
  (typeof operationInputSchemas)[Name]
>;
export type OperationResult<Name extends OperationName> = z.infer<
  (typeof operationResultSchemas)[Name]
>;
