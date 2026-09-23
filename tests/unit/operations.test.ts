import { describe, expect, it } from "vitest";

import {
  OPERATION_NAMES,
  operationInputSchemas,
  operationResultSchemas,
} from "../../src/index.js";
import type { OperationName } from "../../src/index.js";
import { requests, subscription, user } from "../fixtures.js";

const invalidInputs: Record<OperationName, unknown[]> = {
  "system.capabilities": [null, [], { query: "anything" }],
  "users.create": [
    {},
    { email: "invalid" },
    { email: "a@example.com", name: " " },
    { email: "a@example.com", name: "x".repeat(201) },
  ],
  "users.search": [
    {},
    { query: "" },
    { query: " " },
    { query: "x".repeat(257) },
    ...[0, -1, 101, 1.5, "20", null].map((limit) => ({ query: "john", limit })),
  ],
  "users.get": [{}, { userId: "" }, { userId: 123 }],
  "users.ban": [
    {},
    { userId: " " },
    { userId: "u1", reason: " " },
    { userId: "u1", reason: "x".repeat(2001) },
    { userId: "u1", reason: null },
  ],
  "users.unban": [{}, { userId: "" }, { userId: false }],
  "users.revokeSessions": [{}, { userId: "" }, { userId: [] }],
  "subscriptions.get": [{}, { userId: "" }, { userId: null }],
  "subscriptions.changePlan": [
    {},
    { userId: "u1" },
    { userId: "u1", planId: "" },
    { userId: "u1", planId: 1 },
  ],
  "actions.invoke": [
    {},
    { actionId: "grant-free-pro" },
    { actionId: "../action", input: null },
    { actionId: "action", input: { bad: undefined } },
  ],
};

const invalidResults: Record<OperationName, unknown[]> = {
  "system.capabilities": [null, {}, { operations: ["users.search"] }],
  "users.create": [null, {}, { user: null }, { user: {} }],
  "users.search": [
    [],
    { users: "invalid" },
    { users: [{}] },
    { users: Array.from({ length: 101 }, () => user) },
  ],
  "users.get": [user, {}, { user: {} }, { user, secret: "private" }],
  "users.ban": [undefined, {}, true, user],
  "users.unban": [undefined, {}, false, user],
  "users.revokeSessions": [undefined, {}, 1],
  "subscriptions.get": [subscription, {}, { subscription: {} }],
  "subscriptions.changePlan": [undefined, {}, subscription],
  "actions.invoke": [undefined, Infinity, { nested: undefined }],
};

describe.each(OPERATION_NAMES)("%s payloads", (name) => {
  it.each(invalidInputs[name])("rejects invalid input %#", (input: unknown) => {
    expect(operationInputSchemas[name].safeParse(input).success).toBe(false);
  });
  it.each(invalidResults[name])(
    "rejects invalid result %#",
    (result: unknown) => {
      expect(operationResultSchemas[name].safeParse(result).success).toBe(
        false,
      );
    },
  );
  it("does not mutate caller input", () => {
    const input = Object.freeze({ ...requests[name].input });
    expect(operationInputSchemas[name].parse(input)).toEqual(input);
  });
});

it("accepts documented search limits and nullable lookups", () => {
  for (const limit of [1, 100]) {
    expect(
      operationInputSchemas["users.search"].parse({ query: " john ", limit }),
    ).toEqual({ query: " john ", limit });
  }
  expect(operationResultSchemas["users.get"].parse({ user: null })).toEqual({
    user: null,
  });
  expect(
    operationResultSchemas["subscriptions.get"].parse({ subscription: null }),
  ).toEqual({ subscription: null });
  expect(operationInputSchemas["users.ban"].parse({ userId: "u1" })).toEqual({
    userId: "u1",
  });
  expect(
    operationInputSchemas["actions.invoke"].parse({
      actionId: "action",
      input: null,
    }),
  ).toEqual({ actionId: "action", input: null });
});
