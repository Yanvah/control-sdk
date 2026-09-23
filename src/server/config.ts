import { z } from "zod";

import { ownConfiguration } from "../internal/configuration.js";
import { actionIdSchema } from "../internal/schemas.js";
import { requestHeadersSchema } from "../protocol/envelopes.js";
import { actionCapabilitySchema, productSchema } from "../protocol/models.js";
import type { ReplayStore } from "../replay/types.js";
import type {
  ControlHandlerContext,
  SubscriptionsHandlers,
  UsersHandlers,
} from "./types.js";

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

const usersSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      create: z
        .custom<NonNullable<UsersHandlers["create"]>>(isFunction)
        .optional(),
      search: z
        .custom<NonNullable<UsersHandlers["search"]>>(isFunction)
        .optional(),
      get: z.custom<NonNullable<UsersHandlers["get"]>>(isFunction).optional(),
      ban: z.custom<NonNullable<UsersHandlers["ban"]>>(isFunction).optional(),
      unban: z
        .custom<NonNullable<UsersHandlers["unban"]>>(isFunction)
        .optional(),
      revokeSessions: z
        .custom<NonNullable<UsersHandlers["revokeSessions"]>>(isFunction)
        .optional(),
    })
    .transform((users) => {
      Object.setPrototypeOf(users, null);
      return users;
    }),
);

const replayStoreSchema = z.custom<ReplayStore>(
  (value) =>
    z.object({ consume: z.custom(isFunction) }).safeParse(value).success,
);

const subscriptionsSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      get: z
        .custom<NonNullable<SubscriptionsHandlers["get"]>>(isFunction)
        .optional(),
      changePlan: z
        .custom<NonNullable<SubscriptionsHandlers["changePlan"]>>(isFunction)
        .optional(),
    })
    .transform((subscriptions) => {
      Object.setPrototypeOf(subscriptions, null);
      return subscriptions;
    }),
);

const actionSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      ...actionCapabilitySchema.omit({ id: true }).shape,
      input: z.instanceof(z.ZodType).optional(),
      run: z.custom<
        (input: unknown, context: ControlHandlerContext) => unknown
      >(isFunction),
    })
    .transform((action) => {
      Object.setPrototypeOf(action, null);
      return action;
    }),
);

const actionsSchema = z.preprocess(
  ownConfiguration,
  z
    .record(actionIdSchema, actionSchema)
    .transform((actions) => new Map(Object.entries(actions))),
);

const optionsSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      product: z.preprocess(ownConfiguration, productSchema),
      auth: z.preprocess(
        ownConfiguration,
        z.strictObject({
          keyId: requestHeadersSchema.shape.keyId,
          secret: z
            .string()
            .regex(/\S/)
            .refine((value) => {
              const bytes = Buffer.byteLength(value, "utf8");
              return bytes >= 32 && bytes <= 1024;
            }),
        }),
      ),
      replayStore: replayStoreSchema,
      users: usersSchema.optional(),
      subscriptions: subscriptionsSchema.optional(),
      actions: actionsSchema.optional(),
      timestampToleranceMs: z.int().min(0).max(300_000).default(300_000),
      maxBodyBytes: z.int().min(1).max(1_048_576).default(65_536),
      requestTimeoutMs: z.int().min(1).max(60_000).default(10_000),
    })
    .transform((options) => {
      Object.setPrototypeOf(options, null);
      return options;
    }),
);

export type ValidatedOptions = z.output<typeof optionsSchema>;

export function validateOptions(options: unknown): ValidatedOptions {
  try {
    return optionsSchema.parse(options);
  } catch {
    // Configuration errors must not expose secret values through Zod issue data.
    throw new TypeError("Invalid Control handler configuration.");
  }
}
