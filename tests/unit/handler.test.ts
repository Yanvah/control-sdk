import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  capabilitiesSchema,
  controlResponseSchema,
  type User,
} from "../../src/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
  type UsersHandlers,
} from "../../src/server/index.js";
import { user } from "../fixtures.js";
import {
  keyId,
  now,
  product,
  requestId,
  secret,
  signedRequest,
} from "../helpers/signed-request.js";

type HandlerOptions = Parameters<typeof createControlHandler>[0];

function options(overrides: Partial<HandlerOptions> = {}): HandlerOptions {
  return {
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
    ...overrides,
  };
}

async function responseBody(response: Response) {
  return controlResponseSchema.parse(await response.json());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("capability registration", () => {
  test("v2 creation is replay protected and validates the returned user", async () => {
    const create = vi.fn(() => ({ id: "created_1", email: "new@example.com" }));
    const handler = createControlHandler(options({ users: { create } }));
    const body = JSON.stringify({
      operation: "users.create",
      input: { email: "new@example.com" },
    });
    const request = () => signedRequest({ version: "2", body });
    expect(await responseBody(await handler(request()))).toMatchObject({
      ok: true,
      data: { user: { id: "created_1", email: "new@example.com" } },
    });
    expect(await responseBody(await handler(request()))).toMatchObject({
      ok: false,
      error: { code: "REQUEST_REPLAYED" },
    });
    expect(create).toHaveBeenCalledOnce();
    const invalid = createControlHandler(
      options({ users: { create: () => ({ id: "" }) } }),
    );
    expect(await responseBody(await invalid(request()))).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  test("a timed-out creation never reports confirmed success", async () => {
    const handler = createControlHandler(
      options({
        requestTimeoutMs: 5,
        users: { create: () => new Promise<User>(() => undefined) },
      }),
    );
    const pending = handler(
      signedRequest({
        version: "2",
        body: JSON.stringify({
          operation: "users.create",
          input: { email: "new@example.com" },
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(6);
    expect(await responseBody(await pending)).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
  });
  test("an unconfigured product advertises only authenticated discovery", async () => {
    const handler = createControlHandler(options());
    const response = await handler(
      signedRequest({
        body: JSON.stringify({ operation: "system.capabilities", input: {} }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = await responseBody(response);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected capabilities");
    const capabilities = capabilitiesSchema.parse(result.data);
    expect(capabilities).toMatchObject({
      product,
      protocolVersion: "1",
      operations: ["system.capabilities"],
      actions: [],
    });
    expect(capabilities.sdkVersion).toMatch(/^\d+\.\d+\.\d+(?:-.+)?$/);
  });

  test("discovery lists exactly the explicitly registered user operations", async () => {
    const handler = createControlHandler(
      options({
        users: { search: () => [], ban: () => {} },
      }),
    );
    const result = await responseBody(
      await handler(
        signedRequest({
          body: JSON.stringify({ operation: "system.capabilities", input: {} }),
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        operations: ["system.capabilities", "users.search", "users.ban"],
        actions: [],
      },
    });
  });

  test("registration objects with custom prototypes are rejected", () => {
    const search = vi.fn(() => [user]);
    const users = {};
    Object.setPrototypeOf(users, { search });
    expect(() => createControlHandler(options({ users }))).toThrow(TypeError);
    expect(search).not.toHaveBeenCalled();
  });

  test("callbacks inherited from Object.prototype are not registered", async () => {
    const search = vi.fn(() => [user]);
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "search",
    );
    Object.defineProperty(Object.prototype, "search", {
      value: search,
      configurable: true,
    });
    try {
      const handler = createControlHandler(options({ users: {} }));
      expect(await responseBody(await handler(signedRequest()))).toMatchObject({
        ok: false,
        error: { code: "OPERATION_UNSUPPORTED" },
      });
      expect(search).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "search", previous);
      else Reflect.deleteProperty(Object.prototype, "search");
    }
  });

  test("custom replay store methods retain their instance", async () => {
    class CustomReplayStore {
      calls = 0;
      consume(): Promise<boolean> {
        this.calls++;
        return Promise.resolve(true);
      }
    }
    const replayStore = new CustomReplayStore();
    const handler = createControlHandler(
      options({ replayStore, users: { search: () => [] } }),
    );
    expect((await handler(signedRequest())).status).toBe(200);
    expect(replayStore.calls).toBe(1);
  });

  test("registration and credentials are copied when the handler is created", async () => {
    const search = vi.fn(() => [user]);
    const replacement = vi.fn(() => []);
    const config = options({
      product: { ...product },
      users: { search },
    });
    const handler = createControlHandler(config);
    config.product.name = "Changed after registration";
    config.auth.secret = "different-secret-at-least-32-bytes";
    if (config.users) config.users.search = replacement;
    const result = await responseBody(await handler(signedRequest()));
    expect(result).toMatchObject({ ok: true, data: { users: [user] } });
    expect(search).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });
});

describe("user operation routing", () => {
  test.each([undefined, 1, 100])(
    "search receives limit %s with its execution default",
    async (limit) => {
      const search = vi.fn<NonNullable<UsersHandlers["search"]>>(() => [user]);
      const handler = createControlHandler(options({ users: { search } }));
      const input = {
        query: "john@example.com",
        ...(limit === undefined ? {} : { limit }),
      };
      const result = await responseBody(
        await handler(
          signedRequest({
            body: JSON.stringify({ operation: "users.search", input }),
          }),
        ),
      );
      expect(result).toEqual({ ok: true, requestId, data: { users: [user] } });
      expect(search).toHaveBeenCalledWith(
        { query: "john@example.com", limit: limit ?? 20 },
        expect.objectContaining({ requestId, actor: undefined }),
      );
      expect(search.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
      expect(search.mock.calls[0]?.[1].signal.aborted).toBe(false);
    },
  );

  test("async lookup returns the selected user and authenticated actor context", async () => {
    const get = vi.fn<NonNullable<UsersHandlers["get"]>>(() =>
      Promise.resolve(user),
    );
    const actor = { id: "control-admin", email: "admin@example.com" };
    const handler = createControlHandler(options({ users: { get } }));
    const result = await responseBody(
      await handler(
        signedRequest({
          body: JSON.stringify({
            operation: "users.get",
            actor,
            input: { userId: user.id },
          }),
        }),
      ),
    );
    expect(result).toEqual({ ok: true, requestId, data: { user } });
    expect(get).toHaveBeenCalledWith(
      { userId: user.id },
      expect.objectContaining({ requestId, actor }),
    );
    expect(get.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  test("missing users return an explicit null", async () => {
    const handler = createControlHandler(
      options({ users: { get: () => null } }),
    );
    expect(
      await responseBody(
        await handler(
          signedRequest({
            body: JSON.stringify({
              operation: "users.get",
              input: { userId: "missing" },
            }),
          }),
        ),
      ),
    ).toEqual({ ok: true, requestId, data: { user: null } });
  });

  test.each([
    { operation: "users.ban", input: { userId: user.id, reason: "Abuse" } },
    { operation: "users.ban", input: { userId: user.id } },
    { operation: "users.unban", input: { userId: user.id } },
    { operation: "users.revokeSessions", input: { userId: user.id } },
  ])(
    "$operation invokes only its callback and normalizes void to null",
    async ({ operation, input }) => {
      const ban = vi.fn(() => {});
      const unban = vi.fn(() => Promise.resolve());
      const revokeSessions = vi.fn(() => {});
      const handler = createControlHandler(
        options({ users: { ban, unban, revokeSessions } }),
      );
      const response = await handler(
        signedRequest({ body: JSON.stringify({ operation, input }) }),
      );
      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        ok: true,
        requestId,
        data: null,
      });
      for (const [name, callback] of Object.entries({
        ban,
        unban,
        revokeSessions,
      })) {
        if (operation === `users.${name}`) {
          expect(callback).toHaveBeenCalledWith(
            input,
            expect.objectContaining({ requestId }),
          );
        } else {
          expect(callback).not.toHaveBeenCalled();
        }
      }
    },
  );

  test.each([
    { operation: "users.search", input: { query: " " } },
    { operation: "users.search", input: { query: "john", limit: "20" } },
    { operation: "users.search", input: { query: "john", limit: 101 } },
    { operation: "users.get", input: { userId: "" } },
    { operation: "users.ban", input: { userId: user.id, reason: " " } },
    { operation: "users.unban", input: {} },
    { operation: "users.revokeSessions", input: { userId: 1 } },
    { operation: "system.capabilities", input: { extra: true } },
    { operation: "users.search", input: { query: "john" }, extra: true },
    { operation: "users.search", actor: { id: "" }, input: { query: "john" } },
  ])("invalid $operation input never reaches a callback", async (body) => {
    const callback = vi.fn(() => {});
    const search = vi.fn(() => []);
    const get = vi.fn(() => null);
    const handler = createControlHandler(
      options({
        users: {
          search,
          get,
          ban: callback,
          unban: callback,
          revokeSessions: callback,
        },
      }),
    );
    const response = await handler(
      signedRequest({ body: JSON.stringify(body) }),
    );
    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    { operation: "users.search", input: { query: "john" } },
    { operation: "users.delete", input: { userId: user.id } },
    { operation: "constructor", input: {} },
    { operation: "subscriptions.get", input: { userId: user.id } },
    {
      operation: "subscriptions.changePlan",
      input: { userId: user.id, planId: "pro" },
    },
    {
      operation: "actions.invoke",
      input: { actionId: "grant-pro", input: null },
    },
  ])("unregistered $operation is unsupported", async (body) => {
    const handler = createControlHandler(options());
    const response = await handler(
      signedRequest({ body: JSON.stringify(body) }),
    );
    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({
      ok: false,
      error: { code: "OPERATION_UNSUPPORTED" },
    });
  });

  test("routing never derives an operation from the endpoint pathname", async () => {
    const search = vi.fn(() => [user]);
    const ban = vi.fn(() => {});
    const handler = createControlHandler(options({ users: { search, ban } }));
    const response = await handler(
      signedRequest({ url: "https://product.example/users/ban" }),
    );
    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
    expect(ban).not.toHaveBeenCalled();
  });
});

describe("handler result validation", () => {
  test.each([
    { id: "" },
    { id: user.id, email: "invalid-email" },
    { id: user.id, createdAt: "yesterday" },
    { id: user.id, secret: "database-password" },
  ])("invalid user result is sanitized: %j", async (result) => {
    const handler = createControlHandler(
      options({ users: { get: () => result } }),
    );
    const response = await handler(
      signedRequest({
        body: JSON.stringify({
          operation: "users.get",
          input: { userId: user.id },
        }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await responseBody(response)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  test("lookup cannot return a different user's record", async () => {
    const handler = createControlHandler(
      options({ users: { get: () => ({ id: "wrong-user" }) } }),
    );
    expect(
      await responseBody(
        await handler(
          signedRequest({
            body: JSON.stringify({
              operation: "users.get",
              input: { userId: user.id },
            }),
          }),
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });

  test.each([1, undefined])(
    "search cannot exceed requested/default limit %s",
    async (limit) => {
      const users = Array.from({ length: (limit ?? 20) + 1 }, (_, index) => ({
        id: `user-${index}`,
      }));
      const handler = createControlHandler(
        options({ users: { search: () => users } }),
      );
      expect(
        await responseBody(
          await handler(
            signedRequest({
              body: JSON.stringify({
                operation: "users.search",
                input: {
                  query: "john",
                  ...(limit === undefined ? {} : { limit }),
                },
              }),
            }),
          ),
        ),
      ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    },
  );

  test("result accessors are rejected before invoking them", async () => {
    const readId = vi.fn(() => user.id);
    const result: User = {
      get id() {
        return readId();
      },
    };
    const handler = createControlHandler(
      options({ users: { get: () => result } }),
    );
    expect(
      await responseBody(
        await handler(
          signedRequest({
            body: JSON.stringify({
              operation: "users.get",
              input: { userId: user.id },
            }),
          }),
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(readId).not.toHaveBeenCalled();
  });
});

describe("configuration validation", () => {
  test.each([
    { product: { id: "", name: "Product" } },
    { product: { id: "product", name: " " } },
    { auth: { keyId: "invalid key", secret } },
    { auth: { keyId, secret: "short" } },
    { auth: { keyId, secret: " ".repeat(32) } },
    { auth: { keyId, secret: "a".repeat(1025) } },
    { auth: { keyId, secret: 123 } },
    { replayStore: undefined },
    { replayStore: { consume: true } },
    { users: { search: true } },
    { users: { delete: () => {} } },
    { subscriptions: { refund: () => {} } },
    { actions: { unregistered: {} } },
    { timestampToleranceMs: -1 },
    { timestampToleranceMs: 300_001 },
    { timestampToleranceMs: Number.NaN },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 1_048_577 },
    { maxBodyBytes: 1.5 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 60_001 },
    { requestTimeoutMs: "1000" },
  ])("rejects invalid configuration %j", (invalid) => {
    expect(() => {
      Reflect.apply(createControlHandler, undefined, [
        { ...options(), ...invalid },
      ]);
    }).toThrow(TypeError);
  });

  test("configuration errors never include credential values", () => {
    const sensitiveValue = "secret-marker-too-short";
    expect(() =>
      createControlHandler(
        options({ auth: { keyId, secret: sensitiveValue } }),
      ),
    ).toThrow(expect.not.stringContaining(sensitiveValue));
  });

  test("secret length is measured in UTF-8 bytes", () => {
    expect(() =>
      createControlHandler(
        options({ auth: { keyId, secret: "é".repeat(16) } }),
      ),
    ).not.toThrow();
  });
});
