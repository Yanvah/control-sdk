import { expectTypeOf, test } from "vitest";

import {
  controlRequestSchema,
  controlResponseSchema,
} from "../../src/index.js";
import type {
  operationInputSchemas,
  operationResultSchemas,
} from "../../src/index.js";
import type * as publicApi from "../../src/index.js";
import type * as serverApi from "../../src/server/index.js";
import type * as clientApi from "../../src/client/index.js";
import type {
  Actor,
  Capabilities,
  ControlErrorResponse,
  ControlRequest,
  ControlResponse,
  ErrorCode,
  JsonValue,
  OperationInput,
  OperationName,
  OperationResult,
  ProtocolVersion,
  RequestHeaders,
  Subscription,
  User,
} from "../../src/index.js";

test("operation names and payload maps are exhaustive", () => {
  expectTypeOf<ControlRequest["operation"]>().toEqualTypeOf<OperationName>();
  expectTypeOf<
    keyof typeof operationInputSchemas
  >().toEqualTypeOf<OperationName>();
  expectTypeOf<
    keyof typeof operationResultSchemas
  >().toEqualTypeOf<OperationName>();
  expectTypeOf<"users.delete">().not.toMatchTypeOf<OperationName>();
  expectTypeOf<ProtocolVersion>().toEqualTypeOf<"1" | "2">();
  expectTypeOf<RequestHeaders["timestamp"]>().toEqualTypeOf<string>();
});

test("requests preserve the relationship between operation and input", () => {
  const request = controlRequestSchema.parse({});
  if (request.operation === "users.search") {
    expectTypeOf(request.input).toEqualTypeOf<{
      query: string;
      limit?: number | undefined;
    }>();
  }
  if (request.operation === "subscriptions.changePlan") {
    expectTypeOf(request.input).toEqualTypeOf<{
      userId: string;
      planId: string;
    }>();
  }
  if (request.operation === "actions.invoke") {
    expectTypeOf(request.input).toEqualTypeOf<{
      actionId: string;
      input: JsonValue;
    }>();
  }
  expectTypeOf<{
    operation: "users.ban";
    input: { query: string };
  }>().not.toMatchTypeOf<ControlRequest>();
  expectTypeOf<{
    operation: "users.get";
  }>().not.toMatchTypeOf<ControlRequest>();
  expectTypeOf<OperationInput<"users.get">>().toEqualTypeOf<{
    userId: string;
  }>();
  expectTypeOf<Actor>().toEqualTypeOf<{
    id: string;
    email?: string | undefined;
  }>();
});

test("operation results retain useful model types", () => {
  expectTypeOf<OperationResult<"users.search">>().toEqualTypeOf<{
    users: User[];
  }>();
  expectTypeOf<OperationResult<"users.get">>().toEqualTypeOf<{
    user: User | null;
  }>();
  expectTypeOf<OperationResult<"subscriptions.get">>().toEqualTypeOf<{
    subscription: Subscription | null;
  }>();
  expectTypeOf<
    OperationResult<"system.capabilities">
  >().toEqualTypeOf<Capabilities>();
  expectTypeOf<
    OperationResult<
      | "users.ban"
      | "users.unban"
      | "users.revokeSessions"
      | "subscriptions.changePlan"
    >
  >().toEqualTypeOf<null>();
  expectTypeOf<OperationResult<"actions.invoke">>().toEqualTypeOf<JsonValue>();
});

test("response discrimination separates data from normalized errors", () => {
  const response = controlResponseSchema.parse({});
  expectTypeOf(response).toEqualTypeOf<ControlResponse>();
  if (response.ok) {
    expectTypeOf(response.data).toEqualTypeOf<JsonValue>();
    expectTypeOf(response).not.toHaveProperty("error");
  } else {
    expectTypeOf(response).toEqualTypeOf<ControlErrorResponse>();
    expectTypeOf(response.error.code).toEqualTypeOf<ErrorCode>();
    expectTypeOf(response).not.toHaveProperty("data");
  }
  expectTypeOf<"UNKNOWN_ERROR">().not.toMatchTypeOf<ErrorCode>();
});

test("JSON wire types exclude JavaScript-only values", () => {
  expectTypeOf<undefined>().not.toMatchTypeOf<JsonValue>();
  expectTypeOf<Date>().not.toMatchTypeOf<JsonValue>();
  expectTypeOf<bigint>().not.toMatchTypeOf<JsonValue>();
  expectTypeOf<() => void>().not.toMatchTypeOf<JsonValue>();
  expectTypeOf<{
    values: (string | number | null)[];
  }>().toMatchTypeOf<JsonValue>();
});

test("entry points expose only their deliberate public surface", () => {
  expectTypeOf<typeof publicApi>().not.toHaveProperty("hasSafeJsonStructure");
  expectTypeOf<typeof publicApi>().not.toHaveProperty("identifierSchema");
  expectTypeOf<keyof typeof serverApi>().toEqualTypeOf<
    "createControlHandler" | "createMemoryReplayStore" | "ControlHandlerError"
  >();
  expectTypeOf<keyof typeof clientApi>().toEqualTypeOf<
    "createControlClient" | "ControlClientError"
  >();
});
