import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import type {
  Actor,
  JsonValue,
  OperationInput,
  Subscription,
  User,
} from "../../src/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
  type ControlHandler,
  type ControlHandlerContext,
  type ControlHandlerOptions,
  type MemoryReplayStoreOptions,
  type ReplayStore,
  type UsersHandlers,
  type SubscriptionsHandlers,
  type ActionDefinition,
} from "../../src/server/index.js";

test("handler inputs and context are inferred without assertions", () => {
  const handler = createControlHandler({
    product: { id: "product-a", name: "Product A" },
    auth: {
      keyId: "product-a-key",
      secret: "a-test-secret-at-least-32-bytes-long",
    },
    replayStore: createMemoryReplayStore(),
    users: {
      create: (input) => {
        expectTypeOf(input).toEqualTypeOf<OperationInput<"users.create">>();
        return { id: "new-user", email: input.email };
      },
      search: ({ query, limit }, context) => {
        expectTypeOf(query).toEqualTypeOf<string>();
        expectTypeOf(limit).toEqualTypeOf<number>();
        expectTypeOf(context).toEqualTypeOf<ControlHandlerContext>();
        expectTypeOf(context.requestId).toEqualTypeOf<string>();
        expectTypeOf(context.actor).toEqualTypeOf<Actor | undefined>();
        expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
        return [{ id: "user-a" }];
      },
      get: (input) => {
        expectTypeOf(input).toEqualTypeOf<OperationInput<"users.get">>();
        return Promise.resolve(null);
      },
      ban: (input) => {
        expectTypeOf(input).toEqualTypeOf<OperationInput<"users.ban">>();
      },
      unban: (input) => {
        expectTypeOf(input).toEqualTypeOf<OperationInput<"users.unban">>();
        return Promise.resolve();
      },
      revokeSessions: (input) => {
        expectTypeOf(input).toEqualTypeOf<
          OperationInput<"users.revokeSessions">
        >();
      },
    },
    subscriptions: {
      get: (input, context) => {
        expectTypeOf(input).toEqualTypeOf<
          OperationInput<"subscriptions.get">
        >();
        expectTypeOf(context).toEqualTypeOf<ControlHandlerContext>();
        return null;
      },
      changePlan: (input) => {
        expectTypeOf(input).toEqualTypeOf<
          OperationInput<"subscriptions.changePlan">
        >();
      },
    },
  });
  expectTypeOf(handler).toEqualTypeOf<ControlHandler>();
  expectTypeOf(handler).toEqualTypeOf<
    (request: Request) => Promise<Response>
  >();
});

test("handler options require credentials and replay protection", () => {
  expectTypeOf<
    Parameters<typeof createControlHandler>[0]
  >().toEqualTypeOf<ControlHandlerOptions>();
  expectTypeOf<
    ControlHandlerOptions["replayStore"]
  >().toEqualTypeOf<ReplayStore>();
  expectTypeOf<ControlHandlerOptions>().toHaveProperty("subscriptions");
  expectTypeOf<ControlHandlerOptions>().toHaveProperty("actions");
  expectTypeOf<ControlHandlerOptions>().not.toHaveProperty("allowUnsigned");
  expectTypeOf<
    Omit<ControlHandlerOptions, "auth">
  >().not.toMatchTypeOf<ControlHandlerOptions>();
  expectTypeOf<
    Omit<ControlHandlerOptions, "replayStore">
  >().not.toMatchTypeOf<ControlHandlerOptions>();
});

test("callback results preserve operation-specific types", () => {
  expectTypeOf<
    ReturnType<NonNullable<UsersHandlers["search"]>>
  >().toEqualTypeOf<User[] | Promise<User[]>>();
  expectTypeOf<ReturnType<NonNullable<UsersHandlers["get"]>>>().toEqualTypeOf<
    User | null | Promise<User | null>
  >();
  expectTypeOf<
    ReturnType<NonNullable<UsersHandlers["ban"]>>
  >().toEqualTypeOf<void | Promise<void>>();
  expectTypeOf<() => string>().not.toMatchTypeOf<
    NonNullable<UsersHandlers["search"]>
  >();
  expectTypeOf<() => { users: User[] }>().not.toMatchTypeOf<
    NonNullable<UsersHandlers["search"]>
  >();
  expectTypeOf<
    ReturnType<NonNullable<SubscriptionsHandlers["get"]>>
  >().toEqualTypeOf<Subscription | null | Promise<Subscription | null>>();
  expectTypeOf<
    ReturnType<NonNullable<SubscriptionsHandlers["changePlan"]>>
  >().toEqualTypeOf<void | Promise<void>>();
});

test("custom actions infer independent schema outputs and JSON without a schema", () => {
  const inputSchema = z.strictObject({ userId: z.string(), days: z.int() });
  const transformedSchema = z.string().transform((value) => new Date(value));
  const typedAction: ActionDefinition<typeof inputSchema> = {
    label: "Grant Pro",
    description: "Grant a Pro plan.",
    risk: "dangerous",
    input: inputSchema,
    run: ({ userId, days }, context) => {
      expectTypeOf(userId).toEqualTypeOf<string>();
      expectTypeOf(days).toEqualTypeOf<number>();
      expectTypeOf(context).toEqualTypeOf<ControlHandlerContext>();
      return { userId, days };
    },
  };
  createControlHandler({
    product: { id: "product", name: "Product" },
    auth: { keyId: "key", secret: "a-test-secret-at-least-32-bytes-long" },
    replayStore: createMemoryReplayStore(),
    actions: {
      grant: typedAction,
      transform: {
        label: "Transform",
        description: "Transform input.",
        risk: "safe",
        input: transformedSchema,
        run: (input) => {
          expectTypeOf(input).toEqualTypeOf<Date>();
          return input.toISOString();
        },
      },
      echo: {
        label: "Echo",
        description: "Return JSON input.",
        risk: "safe",
        run: (input) => {
          expectTypeOf(input).toEqualTypeOf<JsonValue>();
          return input;
        },
      },
      structured: {
        label: "Structured",
        description: "Validate structured input.",
        risk: "caution",
        input: inputSchema,
        run: ({ userId, days }) => {
          expectTypeOf(userId).toEqualTypeOf<string>();
          expectTypeOf(days).toEqualTypeOf<number>();
          return Promise.resolve({ userId, days });
        },
      },
    },
  });
  expectTypeOf<ActionDefinition<typeof inputSchema>["run"]>()
    .parameter(0)
    .toEqualTypeOf<{ userId: string; days: number }>();
  expectTypeOf<() => Date>().not.toMatchTypeOf<ActionDefinition["run"]>();
  expectTypeOf<() => undefined>().not.toMatchTypeOf<ActionDefinition["run"]>();
  expectTypeOf<
    Omit<ActionDefinition<typeof transformedSchema>, "input">
  >().not.toMatchTypeOf<ActionDefinition<typeof transformedSchema>>();
  expectTypeOf<
    ActionDefinition<typeof transformedSchema>
  >().not.toMatchTypeOf<ActionDefinition>();
  expectTypeOf<ActionDefinition>().not.toMatchTypeOf<
    ActionDefinition<typeof transformedSchema>
  >();
});

test("custom replay stores implement the small atomic consume contract", () => {
  const store: ReplayStore = {
    consume(requestId, expiresAt) {
      expectTypeOf(requestId).toEqualTypeOf<string>();
      expectTypeOf(expiresAt).toEqualTypeOf<Date>();
      return Promise.resolve(true);
    },
  };
  expectTypeOf(store).toEqualTypeOf<ReplayStore>();
  expectTypeOf<ReturnType<typeof store.consume>>().toEqualTypeOf<
    Promise<boolean>
  >();
  expectTypeOf(createMemoryReplayStore()).toEqualTypeOf<ReplayStore>();
  expectTypeOf<MemoryReplayStoreOptions["maxEntries"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<{ consume: () => boolean }>().not.toMatchTypeOf<ReplayStore>();
});
