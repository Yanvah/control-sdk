import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createControlClient,
  ControlClientError,
  type ControlClientOptions,
} from "../../src/client/index.js";
import {
  CONTROL_HEADERS,
  controlRequestSchema,
  requestHeadersSchema,
} from "../../src/index.js";
import { capabilities, requestId, user } from "../fixtures.js";
import { keyId, now, secret } from "../helpers/signed-request.js";

const endpoint = "https://product.example/api/yanvah%20control/";

function options(
  overrides: Partial<ControlClientOptions> = {},
): ControlClientOptions {
  return { endpoint, keyId, secret, ...overrides };
}

function success(request: Request, data: unknown): Response {
  return Response.json({
    ok: true,
    requestId: request.headers.get(CONTROL_HEADERS.requestId),
    data,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("client request construction", () => {
  test("signs the exact UTF-8 bytes and all canonical request fields", async () => {
    const actor = { id: "admin-a", email: "admin@example.com" };
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(request.url).toBe(endpoint);
      expect(request.redirect).toBe("error");
      expect(request.credentials).toBe("omit");
      expect(request.cache).toBe("no-store");
      expect(request.headers.get("content-type")).toMatch(
        /^application\/json(?:;|$)/,
      );
      const headers = requestHeadersSchema.parse({
        version: request.headers.get(CONTROL_HEADERS.version),
        keyId: request.headers.get(CONTROL_HEADERS.keyId),
        timestamp: request.headers.get(CONTROL_HEADERS.timestamp),
        requestId: request.headers.get(CONTROL_HEADERS.requestId),
        signature: request.headers.get(CONTROL_HEADERS.signature),
      });
      expect(headers).toMatchObject({
        version: "1",
        keyId,
        timestamp: String(now),
      });
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = new TextDecoder().decode(bytes);
      expect(controlRequestSchema.parse(JSON.parse(body))).toEqual({
        operation: "users.search",
        actor,
        input: { query: "José@example.com", limit: 3 },
      });
      const canonical = [
        "1",
        keyId,
        String(now),
        headers.requestId,
        "POST",
        "/api/yanvah%20control/",
        createHash("sha256").update(bytes).digest("hex"),
      ].join("\n");
      expect(headers.signature).toBe(
        createHmac("sha256", secret).update(canonical).digest("hex"),
      );
      expect(body).not.toContain(secret);
      expect(request.url).not.toContain(secret);
      return success(request, { users: [user] });
    });
    const client = createControlClient(options({ fetch: transport }));
    await expect(
      client.invoke(
        "users.search",
        { query: "José@example.com", limit: 3 },
        { actor },
      ),
    ).resolves.toEqual({ users: [user] });
    expect(transport).toHaveBeenCalledOnce();
  });

  test("discovery uses the same signed endpoint and fresh IDs for each call", async () => {
    const requestIds: string[] = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requestIds.push(request.headers.get(CONTROL_HEADERS.requestId) ?? "");
      expect(controlRequestSchema.parse(await request.json())).toEqual({
        operation: "system.capabilities",
        input: {},
      });
      return success(request, capabilities);
    });
    const client = createControlClient(options({ fetch: transport }));
    await expect(client.getCapabilities()).resolves.toEqual(capabilities);
    await expect(client.invoke("system.capabilities", {})).resolves.toEqual(
      capabilities,
    );
    expect(new Set(requestIds).size).toBe(2);
  });

  test("uses the platform fetch when no transport is configured", async () => {
    const transport = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve(success(new Request(input, init), { user: null })),
    );
    vi.stubGlobal("fetch", transport);
    const client = createControlClient(options());
    await expect(
      client.invoke("users.get", { userId: "missing" }),
    ).resolves.toEqual({ user: null });
    expect(transport).toHaveBeenCalledOnce();
  });

  test("configuration is copied when the client is created", async () => {
    const transport = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(endpoint);
      expect(request.headers.get(CONTROL_HEADERS.keyId)).toBe(keyId);
      return Promise.resolve(success(request, { user: null }));
    });
    const config = options({ fetch: transport });
    const client = createControlClient(config);
    config.endpoint = "https://different.example/control";
    config.keyId = "different-key";
    config.fetch = () =>
      Promise.reject(new Error("Should not replace transport"));
    await expect(
      client.invoke("users.get", { userId: "missing" }),
    ).resolves.toEqual({ user: null });
  });
});

describe("client configuration validation", () => {
  test.each([
    { endpoint: "not-a-url" },
    { endpoint: "ftp://product.example/control" },
    { endpoint: "http://product.example/control" },
    { endpoint: "https://admin:password@product.example/control" },
    { endpoint: "https://product.example/control?secret=value" },
    { endpoint: "https://product.example/control?" },
    { endpoint: "https://product.example/control#" },
    { endpoint: "http://localhost.evil.example/control" },
    { keyId: "invalid key" },
    { secret: "short" },
    { secret: " ".repeat(32) },
    { secret: "a".repeat(1025) },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { timeoutMs: 1.5 },
    { timeoutMs: "1000" },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 10_485_761 },
    { maxResponseBytes: Number.NaN },
    { fetch: true },
    { allowUnsigned: true },
  ])("rejects invalid configuration %j", (invalid) => {
    expect(() => {
      Reflect.apply(createControlClient, undefined, [
        { ...options(), ...invalid },
      ]);
    }).toThrow(TypeError);
  });

  test.each([
    "http://localhost:3001/control",
    "http://127.0.0.1/control",
    "http://[::1]/control",
  ])("permits signed local development at %s", (localEndpoint) => {
    expect(() =>
      createControlClient(options({ endpoint: localEndpoint })),
    ).not.toThrow();
  });

  test("configuration errors hide invalid credential values", () => {
    expect(() =>
      createControlClient(options({ secret: "sensitive-value" })),
    ).toThrow(expect.not.stringContaining("sensitive-value"));
  });

  test("UTF-8 secret length matches server configuration", () => {
    expect(() =>
      createControlClient(options({ secret: "é".repeat(16) })),
    ).not.toThrow();
  });
});

describe("client input validation", () => {
  test.each([
    ["system.capabilities", { extra: true }],
    ["users.search", { query: " " }],
    ["users.search", { query: "john", limit: "20" }],
    ["users.get", { userId: "" }],
    ["users.ban", { userId: "user-a", reason: " " }],
    ["users.unban", {}],
    ["users.revokeSessions", { userId: 1 }],
    ["subscriptions.get", { userId: null }],
    ["subscriptions.changePlan", { userId: "user-a" }],
    ["actions.invoke", { actionId: "Invalid ID", input: {} }],
    ["actions.invoke", { actionId: "grant-pro", input: undefined }],
  ])(
    "invalid %s input is rejected before sending",
    async (operationName, input) => {
      const transport = vi.fn<typeof fetch>();
      const client = createControlClient(options({ fetch: transport }));
      await expect(
        Reflect.apply(client.invoke.bind(client), undefined, [
          operationName,
          input,
        ]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  test.each(["users.delete", "constructor", "toString", "__proto__"])(
    "unknown operation %s is rejected before sending",
    async (operationName) => {
      const transport = vi.fn<typeof fetch>();
      const client = createControlClient(options({ fetch: transport }));
      await expect(
        Reflect.apply(client.invoke.bind(client), undefined, [
          operationName,
          {},
        ]),
      ).rejects.toMatchObject({ code: "OPERATION_UNSUPPORTED" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  test.each([{ actor: { id: "" } }, { signal: "not-a-signal" }, { secret }])(
    "invalid call options %j are rejected before sending",
    async (invokeOptions) => {
      const transport = vi.fn<typeof fetch>();
      const client = createControlClient(options({ fetch: transport }));
      await expect(
        Reflect.apply(client.invoke.bind(client), undefined, [
          "users.get",
          { userId: "user-a" },
          invokeOptions,
        ]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe("client cancellation and availability", () => {
  test("public client errors have stable codes and correlation IDs", () => {
    const error = new ControlClientError("INVALID_RESPONSE", requestId);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ControlClientError");
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.requestId).toBe(requestId);
    expect(error.message).toBe("The product returned an invalid response.");
  });

  test.each([
    ["UNKNOWN_ERROR", requestId],
    ["INVALID_RESPONSE", "invalid-id"],
    [null, requestId],
  ])("invalid public error arguments are rejected: %j", (code, id) => {
    expect(() => {
      Reflect.construct(ControlClientError, [code, id]);
    }).toThrow(TypeError);
  });

  test("transport failures become sanitized errors without retrying", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`fetch failed: ${secret}`)),
    );
    const client = createControlClient(options({ fetch: transport }));
    const error: unknown = await client
      .invoke("users.ban", { userId: "user-a" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlClientError);
    expect(error).toMatchObject({
      code: "PRODUCT_UNAVAILABLE",
    });
    if (!(error instanceof ControlClientError))
      throw new Error("Expected client error");
    expect(error.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  test("a timeout settles even when the transport ignores cancellation", async () => {
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>((input, init) => {
      transportSignal = new Request(input, init).signal;
      return new Promise<Response>(() => {});
    });
    const client = createControlClient(
      options({ fetch: transport, timeoutMs: 50 }),
    );
    const result = expect(
      client.invoke("users.get", { userId: "user-a" }),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(transportSignal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });

  test("pre-aborted calls never reach the transport", async () => {
    const controller = new AbortController();
    controller.abort(new Error(secret));
    const transport = vi.fn<typeof fetch>();
    const client = createControlClient(options({ fetch: transport }));
    await expect(
      client.getCapabilities({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });

  test("caller cancellation aborts a pending request and hides its reason", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>((input, init) => {
      transportSignal = new Request(input, init).signal;
      return new Promise<Response>(() => {});
    });
    const client = createControlClient(options({ fetch: transport }));
    const promise = client.getCapabilities({ signal: controller.signal });
    const result = expect(promise).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
    controller.abort(new Error(secret));
    await result;
    await expect(promise).rejects.toThrow(expect.not.stringContaining(secret));
    expect(transportSignal?.aborted).toBe(true);
  });

  test("successful calls remove cancellation forwarding and deadline timers", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      transportSignal = request.signal;
      return Promise.resolve(success(request, { user: null }));
    };
    const client = createControlClient(
      options({ fetch: transport, timeoutMs: 50 }),
    );
    await client.invoke(
      "users.get",
      { userId: "missing" },
      { signal: controller.signal },
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(transportSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
