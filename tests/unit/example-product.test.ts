import { afterEach, describe, expect, test, vi } from "vitest";
import { createControlClient } from "@yanvah/control/client";

import { createExampleProduct } from "../../examples/nextjs/lib/product.ts";

const auth = {
  keyId: "example-test-key",
  secret: "example-test-secret-at-least-32-bytes",
};

function fixture(writable = true) {
  const product = createExampleProduct({
    product: { id: "test-product", name: "Test Product" },
    auth,
    writable,
  });
  const client = createControlClient({
    endpoint: "http://127.0.0.1/api/yanvah-control",
    ...auth,
    fetch: (input, init) => product.handler(new Request(input, init)),
  });
  return { ...product, client };
}

afterEach(() => vi.useRealTimers());

describe("fake SaaS business behavior", () => {
  test("searches names and emails without case sensitivity and honors limits", async () => {
    const { client } = fixture();
    await expect(
      client.invoke("users.search", { query: "JOHN@EXAMPLE.COM" }),
    ).resolves.toMatchObject({ users: [{ id: "user_123" }] });
    await expect(
      client.invoke("users.search", { query: "Alex Example" }),
    ).resolves.toMatchObject({ users: [{ id: "user_456" }] });
    const result = await client.invoke("users.search", {
      query: "example.com",
      limit: 1,
    });
    expect(result.users).toHaveLength(1);
  });

  test("revocation clears only that product's selected user's sessions", async () => {
    const first = fixture();
    const second = fixture(false);
    expect(first.state.sessions.get("user_123")).toBe(2);
    await expect(
      first.client.invoke("users.revokeSessions", { userId: "user_123" }),
    ).resolves.toBeNull();
    expect(first.state.sessions.get("user_123")).toBe(0);
    expect(first.state.sessions.get("user_456")).toBe(2);
    expect(second.state.sessions.get("user_123")).toBe(2);
  });

  test("a free Pro grant updates its expiry and an explicit plan change clears it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const { client, state } = fixture();
    await expect(
      client.invoke("actions.invoke", {
        actionId: "grant-free-pro",
        input: { userId: "user_123", days: 30 },
      }),
    ).resolves.toEqual({
      userId: "user_123",
      planId: "pro",
      days: 30,
      currentPeriodEnd: "2026-10-19T12:00:00.000Z",
    });
    expect(state.subscriptions.get("user_123")).toMatchObject({
      planId: "pro",
      currentPeriodEnd: "2026-10-19T12:00:00.000Z",
    });
    await client.invoke("subscriptions.changePlan", {
      userId: "user_123",
      planId: "basic",
    });
    expect(state.subscriptions.get("user_123")).toMatchObject({
      planId: "basic",
      currentPeriodEnd: null,
    });
  });

  test.each([0, 366, 1.5, "30"])(
    "rejects grant duration %j without changing the subscription",
    async (days) => {
      const { client, state } = fixture();
      await expect(
        client.invoke("actions.invoke", {
          actionId: "grant-free-pro",
          input: { userId: "user_123", days },
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(state.subscriptions.get("user_123")).toMatchObject({
        planId: "basic",
        currentPeriodEnd: null,
      });
    },
  );

  test("missing lookups return null and missing mutations cannot create records", async () => {
    const { client, state } = fixture();
    await expect(
      client.invoke("users.get", { userId: "missing" }),
    ).resolves.toEqual({ user: null });
    await expect(
      client.invoke("subscriptions.get", { userId: "missing" }),
    ).resolves.toEqual({ subscription: null });
    await expect(
      client.invoke("users.revokeSessions", { userId: "missing" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      client.invoke("subscriptions.changePlan", {
        userId: "missing",
        planId: "pro",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(state.users.has("missing")).toBe(false);
    expect(state.subscriptions.has("missing")).toBe(false);
    expect(state.sessions.has("missing")).toBe(false);
  });
});
