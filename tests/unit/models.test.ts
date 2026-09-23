import { describe, expect, it } from "vitest";

import {
  actionCapabilitySchema,
  actionRiskSchema,
  actorSchema,
  capabilitiesSchema,
  jsonValueSchema,
  productSchema,
  subscriptionSchema,
  subscriptionStatusSchema,
  userSchema,
} from "../../src/index.js";
import {
  capabilities,
  jsonRoundTrip,
  subscription,
  user,
} from "../fixtures.js";

describe("shared models", () => {
  it("round-trips every model", () => {
    expect(
      actorSchema.parse(
        jsonRoundTrip({ id: "admin", email: "admin@example.com" }),
      ),
    ).toEqual({ id: "admin", email: "admin@example.com" });
    expect(productSchema.parse(jsonRoundTrip(capabilities.product))).toEqual(
      capabilities.product,
    );
    expect(userSchema.parse(jsonRoundTrip(user))).toEqual(user);
    expect(subscriptionSchema.parse(jsonRoundTrip(subscription))).toEqual(
      subscription,
    );
    expect(capabilitiesSchema.parse(jsonRoundTrip(capabilities))).toEqual(
      capabilities,
    );
    for (const action of capabilities.actions) {
      expect(actionCapabilitySchema.parse(jsonRoundTrip(action))).toEqual(
        action,
      );
    }
  });

  it("allows products to omit unavailable optional user fields", () => {
    expect(userSchema.parse({ id: "u1" })).toEqual({ id: "u1" });
    expect(userSchema.parse({ id: "u1", email: null, name: null })).toEqual({
      id: "u1",
      email: null,
      name: null,
    });
    expect(
      subscriptionSchema.safeParse({ ...subscription, currentPeriodEnd: null })
        .success,
    ).toBe(true);
  });

  it.each(["trialing", "active", "past_due", "paused", "canceled"])(
    "accepts normalized subscription status %s",
    (status) => {
      expect(subscriptionStatusSchema.parse(status)).toBe(status);
      expect(
        subscriptionSchema.safeParse({ ...subscription, status }).success,
      ).toBe(true);
    },
  );

  it.each(["safe", "caution", "dangerous"])(
    "requires an explicit risk and accepts %s",
    (risk) => {
      expect(actionRiskSchema.parse(risk)).toBe(risk);
      expect(
        actionCapabilitySchema.safeParse({
          id: "action",
          label: "Action",
          description: "A product action.",
          risk,
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    { id: "" },
    { id: " " },
    { id: "x".repeat(257) },
    { id: "u1", email: "invalid" },
    { id: "u1", email: "x".repeat(255) + "@example.com" },
    { id: "u1", name: "" },
    { id: "u1", name: "x".repeat(201) },
    { id: "u1", banned: "true" },
    { id: "u1", password: "private" },
    { id: "u1", createdAt: new Date("2026-09-19") },
    { id: "u1", createdAt: "2026-09-19" },
    { id: "u1", createdAt: "2026-02-30T12:00:00.000Z" },
    { id: "u1", createdAt: "2026-09-19T12:00:00Z" },
    { id: "u1", createdAt: "2026-09-19T12:00:00.000+00:00" },
  ])("rejects invalid user %#", (value) => {
    expect(userSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { id: "" },
    { userId: "" },
    { planId: "" },
    { status: "unknown" },
    { currentPeriodEnd: "tomorrow" },
    { extra: true },
  ])("rejects invalid subscription %#", (fields) => {
    expect(
      subscriptionSchema.safeParse({ ...subscription, ...fields }).success,
    ).toBe(false);
  });

  it("rejects malformed actors and products", () => {
    for (const actor of [
      {},
      { id: "a", email: null },
      { id: "a", email: "invalid" },
      { id: "a", secret: "private" },
    ]) {
      expect(actorSchema.safeParse(actor).success).toBe(false);
    }
    for (const product of [
      {},
      { id: "p", name: " " },
      { id: "p", name: "x".repeat(201) },
      { id: "p", name: "Product", secret: "private" },
    ]) {
      expect(productSchema.safeParse(product).success).toBe(false);
    }
  });

  it.each([
    { id: "" },
    { id: "../action" },
    { id: "Actions.Run" },
    { id: "a".repeat(65) },
    { risk: undefined },
    { risk: "critical" },
    { label: " " },
    { label: "x".repeat(201) },
    { description: "" },
    { description: "x".repeat(2001) },
    { inputSchema: {} },
  ])("rejects invalid action metadata %#", (fields) => {
    expect(
      actionCapabilitySchema.safeParse({
        id: "action",
        label: "Action",
        description: "A product action.",
        risk: "safe",
        ...fields,
      }).success,
    ).toBe(false);
  });
});

describe("capability declarations", () => {
  it("accepts discovery as the only capability", () => {
    expect(
      capabilitiesSchema.safeParse({
        ...capabilities,
        operations: ["system.capabilities"],
        actions: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    { protocolVersion: "3" },
    { operations: ["system.capabilities", "users.create", "actions.invoke"] },
    { sdkVersion: "" },
    { sdkVersion: "x".repeat(65) },
    { operations: [] },
    { operations: ["users.search"] },
    { operations: ["system.capabilities", "arbitrary.operation"] },
    {
      operations: [
        "system.capabilities",
        "system.capabilities",
        "actions.invoke",
      ],
    },
    { actions: [...capabilities.actions, ...capabilities.actions] },
    { actions: [] },
    { operations: ["system.capabilities"] },
    { extra: true },
  ])("rejects inconsistent or invalid capabilities %#", (fields) => {
    expect(
      capabilitiesSchema.safeParse({ ...capabilities, ...fields }).success,
    ).toBe(false);
  });
});

describe("JSON wire values", () => {
  it.each([
    null,
    true,
    false,
    0,
    -2.5,
    "text",
    [],
    {},
    { values: [1, null, { nested: "value" }] },
  ])("round-trips JSON value %#", (value) => {
    expect(jsonValueSchema.parse(jsonRoundTrip(value))).toEqual(value);
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("value"),
    () => 1,
    new Date("2026-09-19"),
    new Map(),
    new Set(),
    /pattern/,
    [undefined],
    { nested: { value: undefined } },
    { nested: [Infinity] },
    JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
    JSON.parse(
      '{"nested":{"constructor":{"prototype":{"polluted":true}}}}',
    ) as unknown,
    { prototype: {} },
    { [Symbol("key")]: true },
  ])("rejects non-JSON or unsafe value %#", (value: unknown) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
  });

  it("rejects cycles and overly deep JSON without overflowing the stack", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(jsonValueSchema.safeParse(cycle).success).toBe(false);
    let nested: unknown = null;
    for (let index = 0; index < 64; index += 1) nested = [nested];
    expect(jsonValueSchema.safeParse(nested).success).toBe(true);
    expect(jsonValueSchema.safeParse([nested]).success).toBe(false);
  });

  it("permits repeated non-cyclic references", () => {
    const shared = { value: true };
    expect(jsonValueSchema.parse([shared, shared])).toEqual([shared, shared]);
  });

  it("rejects values that would silently change during serialization", () => {
    const arrayWithProperty = Object.assign([1], { extra: true });
    const arrayWithNonIndex = Object.assign([1], { "4294967295": true });
    const getterObject = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("Getter must not run.");
      },
    });
    for (const value of [
      arrayWithProperty,
      arrayWithNonIndex,
      getterObject,
      new Array<unknown>(1),
      Object.defineProperty({}, "hidden", { value: 1 }),
    ]) {
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
    }
  });
});
