import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createControlClient,
  type ControlClientOptions,
} from "../../src/client/index.js";
import { CONTROL_HEADERS, type ErrorCode } from "../../src/index.js";
import { capabilities, requestId, subscription, user } from "../fixtures.js";
import { keyId, now, secret } from "../helpers/signed-request.js";

function clientWithResponse(
  respond: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ControlClientOptions> = {},
) {
  const transport: typeof fetch = (input, init) =>
    Promise.resolve(respond(new Request(input, init)));
  return createControlClient({
    endpoint: "https://product.example/control",
    keyId,
    secret,
    fetch: transport,
    ...overrides,
  });
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
});

describe("strict response validation", () => {
  test.each([
    { redirected: true },
    { url: "https://different.example/control" },
  ])(
    "rejects redirected or retargeted transport responses: %j",
    async (properties) => {
      const client = clientWithResponse((request) => {
        const response = success(request, { user: null });
        for (const [name, value] of Object.entries(properties)) {
          Object.defineProperty(response, name, { value });
        }
        return response;
      });
      await expect(
        client.invoke("users.get", { userId: user.id }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );

  test("unexpected transport response accessors cannot expose their exceptions", async () => {
    const client = clientWithResponse((request) => {
      const response = success(request, { user: null });
      Object.defineProperty(response, "redirected", {
        get() {
          throw new Error(secret);
        },
      });
      return response;
    });
    const result = client.invoke("users.get", { userId: user.id });
    await expect(result).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(result).rejects.toThrow(expect.not.stringContaining(secret));
  });

  test.each([
    { name: "invalid JSON", body: "{", status: 200 },
    { name: "HTML error page", body: "<h1>Bad gateway</h1>", status: 502 },
    { name: "array envelope", body: "[]", status: 200 },
    {
      name: "missing request ID",
      body: '{"ok":true,"data":{"user":null}}',
      status: 200,
    },
    {
      name: "wrong request ID",
      body: JSON.stringify({ ok: true, requestId, data: { user: null } }),
      status: 200,
    },
  ])("rejects $name", async ({ body, status }) => {
    const client = clientWithResponse(
      () =>
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test.each([
    { ok: true, data: { user: null }, extra: "unexpected" },
    { ok: true, data: { user: { id: "" } } },
    { ok: true, data: { user: { id: user.id, secret } } },
    { ok: true, data: { users: [] } },
    { ok: false, error: { code: "UNKNOWN_ERROR", message: "Unknown" } },
    { ok: false, error: { code: "INTERNAL_ERROR", message: " " } },
    {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Failure", stack: secret },
    },
  ])("rejects a malformed envelope or operation result: %j", async (body) => {
    const client = clientWithResponse((request) =>
      Response.json(
        {
          ...body,
          requestId: request.headers.get(CONTROL_HEADERS.requestId),
        },
        { status: body.ok ? 200 : 500 },
      ),
    );
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test.each([
    "text/plain",
    "application/json; charset=iso-8859-1",
    "application/json, text/html",
    "",
  ])("rejects response content type %s", async (contentType) => {
    const client = clientWithResponse((request) => {
      const response = success(request, { user: null });
      if (contentType) response.headers.set("content-type", contentType);
      else response.headers.delete("content-type");
      return response;
    });
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects invalid UTF-8 even inside an otherwise valid JSON string", async () => {
    const client = clientWithResponse((request) => {
      const prefix = Buffer.from(
        `{"ok":true,"requestId":"${request.headers.get(CONTROL_HEADERS.requestId)}","data":"`,
      );
      return new Response(
        Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}')]),
        { headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      client.invoke("actions.invoke", { actionId: "echo", input: null }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects prototype-pollution-shaped JSON", async () => {
    const client = clientWithResponse(
      (request) =>
        new Response(
          `{"ok":true,"requestId":"${request.headers.get(CONTROL_HEADERS.requestId)}","data":{"__proto__":{"polluted":true}}}`,
          { headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      client.invoke("actions.invoke", { actionId: "echo", input: null }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  test("rejects successful envelopes returned with a failure HTTP status", async () => {
    const client = clientWithResponse((request) =>
      Response.json(
        {
          ok: true,
          requestId: request.headers.get(CONTROL_HEADERS.requestId),
          data: { user: null },
        },
        { status: 500 },
      ),
    );
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects errors with a mismatched HTTP status", async () => {
    const client = clientWithResponse((request) =>
      Response.json(
        {
          ok: false,
          requestId: request.headers.get(CONTROL_HEADERS.requestId),
          error: { code: "AUTHENTICATION_FAILED", message: "Failure" },
        },
        { status: 200 },
      ),
    );
    await expect(client.getCapabilities()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  test.each([
    ["AUTHENTICATION_FAILED", 401],
    ["REQUEST_EXPIRED", 401],
    ["REQUEST_REPLAYED", 409],
    ["INVALID_INPUT", 400],
    ["OPERATION_UNSUPPORTED", 400],
    ["PRODUCT_UNAVAILABLE", 503],
    ["REQUEST_TIMEOUT", 504],
    ["INTERNAL_ERROR", 500],
  ] satisfies [ErrorCode, number][])(
    "normalizes %s without exposing the remote message",
    async (code, status) => {
      const client = clientWithResponse((request) =>
        Response.json(
          {
            ok: false,
            requestId: request.headers.get(CONTROL_HEADERS.requestId),
            error: {
              code,
              message: `${secret} database stack at private.ts:42`,
            },
          },
          { status },
        ),
      );
      const error: unknown = await client
        .getCapabilities()
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code });
      expect(error).toHaveProperty("requestId");
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("private.ts");
      expect(error).not.toHaveProperty("cause");
    },
  );

  test("rejects a lookup for another user", async () => {
    const client = clientWithResponse((request) =>
      success(request, { user: { ...user, id: "another-user" } }),
    );
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects a subscription belonging to another user", async () => {
    const client = clientWithResponse((request) =>
      success(request, {
        subscription: { ...subscription, userId: "another-user" },
      }),
    );
    await expect(
      client.invoke("subscriptions.get", { userId: user.id }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test.each([1, undefined])(
    "enforces requested/default search limit %s",
    async (limit) => {
      const users = Array.from({ length: (limit ?? 20) + 1 }, (_, index) => ({
        id: `user-${index}`,
      }));
      const client = clientWithResponse((request) =>
        success(request, { users }),
      );
      await expect(
        client.invoke("users.search", {
          query: "john",
          ...(limit === undefined ? {} : { limit }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );

  test("rejects incompatible protocol versions in discovery", async () => {
    const client = clientWithResponse((request) =>
      success(request, { ...capabilities, protocolVersion: "2" }),
    );
    await expect(client.getCapabilities()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("bounded response reading", () => {
  test.each([false, true])(
    "a monotonic deadline wins when transport %s blocks the timer",
    async (throws) => {
      let monotonicNow = 0;
      vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
      const client = clientWithResponse(
        (request) => {
          monotonicNow = 51;
          if (throws) throw new Error(secret);
          return success(request, { user: null });
        },
        { timeoutMs: 50 },
      );
      await expect(
        client.invoke("users.get", { userId: user.id }),
      ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    },
  );

  test("counts actual streamed bytes without relying on Content-Length", async () => {
    const cancel = vi.fn();
    const client = clientWithResponse(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(101));
            },
            cancel,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      { maxResponseBytes: 100 },
    );
    await expect(client.getCapabilities()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test.each(["-1", "01", "invalid", "999999999999999999999999", "1", "1001"])(
    "rejects invalid, mismatched, or oversized Content-Length %s",
    async (contentLength) => {
      const client = clientWithResponse(
        (request) => {
          const response = success(request, { user: null });
          response.headers.set("content-length", contentLength);
          return response;
        },
        { maxResponseBytes: 1000 },
      );
      await expect(
        client.invoke("users.get", { userId: user.id }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );

  test("does not compare compressed Content-Length with decoded bytes", async () => {
    const client = clientWithResponse((request) => {
      const response = success(request, { user: null });
      response.headers.set("content-encoding", "gzip");
      response.headers.set("content-length", "1");
      return response;
    });
    await expect(
      client.invoke("users.get", { userId: user.id }),
    ).resolves.toEqual({ user: null });
  });

  test("times out a stalled body even if cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const client = clientWithResponse(
      () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { "content-type": "application/json" },
        }),
      { timeoutMs: 50 },
    );
    const result = expect(client.getCapabilities()).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("stream failures are sanitized as malformed responses", async () => {
    const client = clientWithResponse(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(secret));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const result = client.getCapabilities();
    await expect(result).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(result).rejects.toThrow(expect.not.stringContaining(secret));
  });

  test("releases a late response after a non-cooperative fetch times out", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const cancel = vi.fn();
    const client = clientWithResponse(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      { timeoutMs: 50 },
    );
    const result = expect(client.getCapabilities()).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    resolveFetch?.(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
