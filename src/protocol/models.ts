import { z } from "zod";

import { hasSafeJsonStructure } from "../internal/json.js";
import {
  actionIdSchema,
  dateTimeSchema,
  identifierSchema,
} from "../internal/schemas.js";
import { operationNameSchema, protocolVersionSchema } from "./constants.js";

export const jsonValueSchema = z
  .unknown()
  .refine((value) => hasSafeJsonStructure(value), {
    message:
      "Expected a JSON tree with safe keys and at most 64 container levels.",
  })
  .pipe(z.json());

export const actorSchema = z.strictObject({
  id: identifierSchema,
  email: z.email().max(254).optional(),
});

export const productSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1).max(200).regex(/\S/),
});

export const userSchema = z.strictObject({
  id: identifierSchema,
  email: z.email().max(254).nullable().optional(),
  name: z.string().min(1).max(200).nullable().optional(),
  banned: z.boolean().optional(),
  createdAt: dateTimeSchema.optional(),
});

export const subscriptionStatusSchema = z.enum([
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
]);

export const subscriptionSchema = z.strictObject({
  id: identifierSchema,
  userId: identifierSchema,
  planId: identifierSchema,
  status: subscriptionStatusSchema,
  currentPeriodEnd: dateTimeSchema.nullable().optional(),
});

export const actionRiskSchema = z.enum(["safe", "caution", "dangerous"]);

export const actionCapabilitySchema = z.strictObject({
  id: actionIdSchema,
  label: z.string().min(1).max(200).regex(/\S/),
  description: z.string().min(1).max(2000).regex(/\S/),
  risk: actionRiskSchema,
});

export const capabilitiesSchema = z
  .strictObject({
    product: productSchema,
    sdkVersion: z.string().min(1).max(64).regex(/\S/),
    protocolVersion: protocolVersionSchema,
    operations: z.array(operationNameSchema),
    actions: z.array(actionCapabilitySchema),
  })
  .superRefine((capabilities, context) => {
    if (
      new Set(capabilities.operations).size !== capabilities.operations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Operation names must be unique.",
      });
    }
    if (!capabilities.operations.includes("system.capabilities")) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Capability discovery must be supported.",
      });
    }
    if (
      capabilities.protocolVersion === "1" &&
      capabilities.operations.includes("users.create")
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Protocol v1 cannot advertise users.create.",
      });
    }
    if (
      new Set(capabilities.actions.map((action) => action.id)).size !==
      capabilities.actions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Action IDs must be unique.",
      });
    }
    if (
      capabilities.operations.includes("actions.invoke") !==
      capabilities.actions.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Advertise actions.invoke exactly when actions are listed.",
      });
    }
  });

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type Product = z.infer<typeof productSchema>;
export type User = z.infer<typeof userSchema>;
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ActionCapability = z.infer<typeof actionCapabilitySchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
