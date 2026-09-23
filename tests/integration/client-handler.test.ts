import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  createControlClient,
  ControlClientError,
} from "../../src/client/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
  ControlHandlerError,
  type ControlHandler,
  type ControlHandlerContext,
  type UsersHandlers,
} from "../../src/server/index.js";
import { CONTROL_HEADERS, V1_OPERATION_NAMES } from "../../src/index.js";
import { subscription, user } from "../fixtures.js";
import { keyId, now, product, secret } from "../helpers/signed-request.js";

function transportTo(handler: ControlHandler): typeof fetch {
  return (input, init) => handler(new Request(input, init));
}

function fixture() {
  const search = vi.fn<NonNullable<UsersHandlers["search"]>>(() => [user]);
  const get = vi.fn(() => user);
  const ban = vi.fn(() => {});
  const unban = vi.fn(() => {});
  const revokeSessions = vi.fn(() => {});
  const getSubscription = vi.fn(() => subscription);
  const changePlan = vi.fn(() => {});
  const grant = vi.fn(
    (
      { days }: { userId: string; days: number },
      context: ControlHandlerContext,
    ) => ({ granted: true, days, actorId: context.actor?.id ?? null }),
  );
  const handler = createControlHandler({
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
    users: { search, get, ban, unban, revokeSessions },
    subscriptions: { get: getSubscription, changePlan },
    actions: {
      "grant-free-pro": {
        label: "Grant Free Pro",
        description: "Grant complimentary Pro access.",
        risk: "dangerous",
        input: z.strictObject({
          userId: z.string().min(1),
          days: z.int().min(1).max(365),
        }),
        run: grant,
      },
      echo: {
        label: "Echo",
        description: "Return a JSON payload.",
        risk: "safe",
        run: (input) => input,
      },
    },
  });
  const client = createControlClient({
    endpoint: "https://product.example/control",
    keyId,
    secret,
    fetch: transportTo(handler),
  });
  return {
    client,
    handler,
    search,
    get,
    ban,
    unban,
    revokeSessions,
    getSubscription,
    changePlan,
    grant,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("real signed client and handler round trips", () => {
  test("v2 creates users while v1 discovery and operations remain unchanged", async () => {
    const create = vi.fn(
      ({ email, name }: { email: string; name?: string | undefined }) => {
        if (email === "existing@example.com")
          throw new ControlHandlerError("USER_ALREADY_EXISTS");
        return { id: "new_123", email, ...(name ? { name } : {}) };
      },
    );
    const handler = createControlHandler({
      product,
      auth: { keyId, secret },
      replayStore: createMemoryReplayStore(),
      users: { create },
    });
    const connection = {
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transportTo(handler),
    };
    const v1 = createControlClient(connection);
    const v2 = createControlClient({ ...connection, protocolVersion: "2" });
    await expect(v1.getCapabilities()).resolves.toMatchObject({
      protocolVersion: "1",
      operations: ["system.capabilities"],
    });
    await expect(
      v1.invoke("users.create", { email: "new@example.com" }),
    ).rejects.toMatchObject({ code: "OPERATION_UNSUPPORTED" });
    expect(create).not.toHaveBeenCalled();
    await expect(v2.getCapabilities()).resolves.toMatchObject({
      protocolVersion: "2",
      operations: ["system.capabilities", "users.create"],
    });
    await expect(
      v2.invoke("users.create", { email: "new@example.com", name: "New" }),
    ).resolves.toEqual({
      user: { id: "new_123", email: "new@example.com", name: "New" },
    });
    await expect(
      v2.invoke("users.create", { email: "existing@example.com" }),
    ).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
    expect(create).toHaveBeenCalledTimes(2);
  });
  test("discovery reports all explicitly registered operations and safe action metadata", async () => {
    const { client } = fixture();
    const capabilities = await client.getCapabilities();
    expect(capabilities.product).toEqual(product);
    expect(capabilities.operations).toEqual(V1_OPERATION_NAMES);
    expect(capabilities.actions).toEqual([
      {
        id: "grant-free-pro",
        label: "Grant Free Pro",
        description: "Grant complimentary Pro access.",
        risk: "dangerous",
      },
      {
        id: "echo",
        label: "Echo",
        description: "Return a JSON payload.",
        risk: "safe",
      },
    ]);
    expect(JSON.stringify(capabilities)).not.toContain(secret);
    expect(capabilities.actions[0]).not.toHaveProperty("input");
    expect(capabilities.actions[0]).not.toHaveProperty("run");
  });

  test("user operations preserve typed data, validated input, and actor attribution", async () => {
    const { client, search, get, ban, unban, revokeSessions } = fixture();
    const actor = { id: "control-admin", email: "admin@example.com" };
    await expect(
      client.invoke("users.search", { query: "john@example.com" }),
    ).resolves.toEqual({ users: [user] });
    expect(search).toHaveBeenCalledWith(
      { query: "john@example.com", limit: 20 },
      expect.any(Object),
    );
    expect(search.mock.calls[0]?.[1].requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(search.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).resolves.toEqual({ user });
    expect(get).toHaveBeenCalledOnce();
    await expect(
      client.invoke(
        "users.ban",
        { userId: user.id, reason: "Abuse" },
        { actor },
      ),
    ).resolves.toBeNull();
    expect(ban).toHaveBeenCalledWith(
      { userId: user.id, reason: "Abuse" },
      expect.objectContaining({ actor }),
    );
    await expect(
      client.invoke("users.unban", { userId: user.id }),
    ).resolves.toBeNull();
    expect(unban).toHaveBeenCalledOnce();
    await expect(
      client.invoke("users.revokeSessions", { userId: user.id }),
    ).resolves.toBeNull();
    expect(revokeSessions).toHaveBeenCalledOnce();
  });

  test("subscription lookup and plan changes use the signed protocol", async () => {
    const { client, getSubscription, changePlan } = fixture();
    await expect(
      client.invoke("subscriptions.get", { userId: user.id }),
    ).resolves.toEqual({ subscription });
    expect(getSubscription).toHaveBeenCalledWith(
      { userId: user.id },
      expect.any(Object),
    );
    await expect(
      client.invoke("subscriptions.changePlan", {
        userId: user.id,
        planId: "enterprise",
      }),
    ).resolves.toBeNull();
    expect(changePlan).toHaveBeenCalledWith(
      { userId: user.id, planId: "enterprise" },
      expect.any(Object),
    );
  });

  test("schema-validated custom actions receive input and actor context", async () => {
    const { client, grant } = fixture();
    await expect(
      client.invoke(
        "actions.invoke",
        { actionId: "grant-free-pro", input: { userId: user.id, days: 30 } },
        { actor: { id: "admin-a" } },
      ),
    ).resolves.toEqual({ granted: true, days: 30, actorId: "admin-a" });
    expect(grant).toHaveBeenCalledOnce();
  });

  test("actions without a schema accept JSON values", async () => {
    const { client } = fixture();
    const payload = { message: "Hello", values: [1, true, null] };
    await expect(
      client.invoke("actions.invoke", { actionId: "echo", input: payload }),
    ).resolves.toEqual(payload);
  });

  test.each([
    { userId: user.id, days: 0 },
    { userId: user.id, days: "30" },
    { userId: user.id, days: 30, extra: true },
  ])(
    "custom schema rejects invalid input %j before its callback",
    async (input) => {
      const { client, grant } = fixture();
      await expect(
        client.invoke("actions.invoke", { actionId: "grant-free-pro", input }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(grant).not.toHaveBeenCalled();
    },
  );

  test("an unregistered action cannot invoke another callback", async () => {
    const { client, grant } = fixture();
    await expect(
      client.invoke("actions.invoke", { actionId: "missing", input: {} }),
    ).rejects.toMatchObject({ code: "OPERATION_UNSUPPORTED" });
    expect(grant).not.toHaveBeenCalled();
  });

  test("unregistered operations are normalized client errors", async () => {
    const handler = createControlHandler({
      product,
      auth: { keyId, secret },
      replayStore: createMemoryReplayStore(),
    });
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transportTo(handler),
    });
    await expect(
      client.invoke("users.ban", { userId: user.id }),
    ).rejects.toMatchObject({ code: "OPERATION_UNSUPPORTED" });
    await expect(client.getCapabilities()).resolves.toMatchObject({
      operations: ["system.capabilities"],
    });
  });

  test("wrong connection credentials never execute a handler", async () => {
    const { handler, search } = fixture();
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret: "a-different-secret-at-least-32-bytes",
      fetch: transportTo(handler),
    });
    await expect(
      client.invoke("users.search", { query: "john" }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(search).not.toHaveBeenCalled();
  });

  test("a modified body fails the real signature verifier", async () => {
    const { handler, search } = fixture();
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      return handler(
        new Request(request, {
          body: JSON.stringify({
            operation: "users.search",
            input: { query: "modified" },
          }),
        }),
      );
    };
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transport,
    });
    await expect(
      client.invoke("users.search", { query: "john" }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(search).not.toHaveBeenCalled();
  });

  test("handler exceptions reach the client without sensitive details", async () => {
    const handler = createControlHandler({
      product,
      auth: { keyId, secret },
      replayStore: createMemoryReplayStore(),
      users: {
        get: () => {
          throw new Error(`${secret} database error at service.ts:42`);
        },
      },
    });
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transportTo(handler),
    });
    const error: unknown = await client
      .invoke("users.get", { userId: user.id })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlClientError);
    expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("service.ts");
  });

  test("client timeout propagates to the real handler context", async () => {
    let handlerSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = createControlHandler({
      product,
      auth: { keyId, secret },
      replayStore: createMemoryReplayStore(),
      users: {
        get: (_input, context) => {
          handlerSignal = context.signal;
          markStarted?.();
          return new Promise<null>(() => {});
        },
      },
    });
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transportTo(handler),
      timeoutMs: 50,
    });
    const result = expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await started;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(handlerSignal?.aborted).toBe(true);
  });

  test("response request IDs must match the signed request", async () => {
    const { handler } = fixture();
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get(CONTROL_HEADERS.signature)).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const response = await handler(request);
      const body: unknown = await response.json();
      const envelope = z
        .object({ ok: z.literal(true), data: z.unknown() })
        .parse(body);
      return Response.json({
        ...envelope,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
    };
    const client = createControlClient({
      endpoint: "https://product.example/control",
      keyId,
      secret,
      fetch: transport,
    });
    await expect(client.getCapabilities()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
