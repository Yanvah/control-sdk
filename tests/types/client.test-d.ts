import { expectTypeOf, test } from "vitest";

import {
  createControlClient,
  type ControlClientError,
  type ControlClient,
  type ControlClientErrorCode,
  type ControlClientOptions,
  type ControlInvokeOptions,
} from "../../src/client/index.js";
import type {
  Actor,
  Capabilities,
  ErrorCode,
  JsonValue,
  Subscription,
  User,
} from "../../src/index.js";

const client = createControlClient({
  endpoint: "https://product.example/api/control",
  keyId: "product-key",
  secret: "a-test-secret-at-least-32-bytes-long",
});

test("client operations infer their precise response types", () => {
  expectTypeOf(client).toEqualTypeOf<ControlClient>();
  expectTypeOf(client.getCapabilities()).toEqualTypeOf<Promise<Capabilities>>();
  expectTypeOf(client.invoke("system.capabilities", {})).toEqualTypeOf<
    Promise<Capabilities>
  >();
  expectTypeOf(client.invoke("users.search", { query: "john" })).toEqualTypeOf<
    Promise<{ users: User[] }>
  >();
  expectTypeOf(client.invoke("users.get", { userId: "user-a" })).toEqualTypeOf<
    Promise<{ user: User | null }>
  >();
  expectTypeOf(
    client.invoke("users.create", { email: "new@example.com" }),
  ).toEqualTypeOf<Promise<{ user: User }>>();
  expectTypeOf(
    client.invoke("subscriptions.get", { userId: "user-a" }),
  ).toEqualTypeOf<Promise<{ subscription: Subscription | null }>>();
  expectTypeOf(
    client.invoke("users.ban", { userId: "user-a", reason: "Abuse" }),
  ).toEqualTypeOf<Promise<null>>();
  expectTypeOf(
    client.invoke("users.unban", { userId: "user-a" }),
  ).toEqualTypeOf<Promise<null>>();
  expectTypeOf(
    client.invoke("users.revokeSessions", { userId: "user-a" }),
  ).toEqualTypeOf<Promise<null>>();
  expectTypeOf(
    client.invoke("subscriptions.changePlan", {
      userId: "user-a",
      planId: "pro",
    }),
  ).toEqualTypeOf<Promise<null>>();
  expectTypeOf(
    client.invoke("actions.invoke", {
      actionId: "grant-pro",
      input: { days: 30 },
    }),
  ).toEqualTypeOf<Promise<JsonValue>>();
});

test("operation names determine their accepted inputs", () => {
  // @ts-expect-error Search fields do not belong to users.get.
  void client.invoke("users.get", { query: "john" });
  // @ts-expect-error Unsupported operation names are not part of the API.
  void client.invoke("users.delete", { userId: "user-a" });
  // @ts-expect-error A plan change requires its new plan ID.
  void client.invoke("subscriptions.changePlan", { userId: "user-a" });
  // @ts-expect-error Discovery still requires an input object through invoke.
  void client.invoke("system.capabilities");
  void client.invoke("actions.invoke", {
    actionId: "grant-pro",
    // @ts-expect-error Action payloads must be JSON-compatible.
    input: new Date(),
  });
});

test("configuration and call options keep credentials separate from attribution", () => {
  expectTypeOf<
    Parameters<typeof createControlClient>[0]
  >().toEqualTypeOf<ControlClientOptions>();
  expectTypeOf<ControlClientOptions["fetch"]>().toEqualTypeOf<
    typeof fetch | undefined
  >();
  expectTypeOf<ControlInvokeOptions["signal"]>().toEqualTypeOf<
    AbortSignal | undefined
  >();
  expectTypeOf<ControlInvokeOptions["actor"]>().toEqualTypeOf<
    Actor | undefined
  >();
  expectTypeOf<
    Omit<ControlClientOptions, "secret">
  >().not.toMatchTypeOf<ControlClientOptions>();
  expectTypeOf<ControlInvokeOptions>().not.toHaveProperty("secret");
});

test("client errors extend the fixed wire codes without modifying them", () => {
  expectTypeOf<ControlClientError>().toExtend<Error>();
  expectTypeOf<
    ControlClientError["code"]
  >().toEqualTypeOf<ControlClientErrorCode>();
  expectTypeOf<ControlClientError["requestId"]>().toEqualTypeOf<string>();
  expectTypeOf<ControlClientErrorCode>().toEqualTypeOf<
    ErrorCode | "INVALID_RESPONSE" | "REQUEST_ABORTED"
  >();
  expectTypeOf<"INVALID_RESPONSE">().not.toMatchTypeOf<ErrorCode>();
  expectTypeOf<"REQUEST_ABORTED">().not.toMatchTypeOf<ErrorCode>();
});
