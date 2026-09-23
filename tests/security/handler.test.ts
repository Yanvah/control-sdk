import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlResponseSchema, type ErrorCode } from "../../src/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
} from "../../src/server/index.js";
import { user } from "../fixtures.js";
import {
  keyId,
  now,
  product,
  requestId,
  secondRequestId,
  secret,
  signedRequest,
} from "../helpers/signed-request.js";

type HandlerOptions = Parameters<typeof createControlHandler>[0];

function setup(overrides: Partial<HandlerOptions> = {}) {
  const search = vi.fn(() => [user]);
  const handler = createControlHandler({
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
    users: { search },
    ...overrides,
  });
  return { handler, search };
}

async function expectError(
  response: Response,
  status: number,
  code: ErrorCode,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  const result = controlResponseSchema.parse(await response.json());
  expect(result).toMatchObject({ ok: false, error: { code } });
  return result;
}

function streamingRequest(
  body: ReadableStream<Uint8Array>,
  source = signedRequest(),
): Request {
  const init = {
    method: "POST",
    headers: source.headers,
    body,
    duplex: "half",
  };
  return new Request(source.url, init);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("authentication boundary", () => {
  test("a valid independent signature executes the handler", async () => {
    const { handler, search } = setup();
    const response = await handler(signedRequest());
    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
  });

  test("localhost still requires a signature", async () => {
    const { handler, search } = setup();
    await expectError(
      await handler(
        new Request("http://localhost/api/yanvah-control", {
          method: "POST",
          body: JSON.stringify({
            operation: "users.search",
            input: { query: "john" },
          }),
        }),
      ),
      401,
      "AUTHENTICATION_FAILED",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test("JavaScript callers cannot substitute an arbitrary request object", async () => {
    const { handler, search } = setup();
    const response: unknown = await Reflect.apply(handler, undefined, [{}]);
    if (!(response instanceof Response))
      throw new Error("Expected a normalized response");
    await expectError(response, 400, "INVALID_INPUT");
    expect(search).not.toHaveBeenCalled();
  });

  test.each([
    "x-yanvah-version",
    "x-yanvah-key-id",
    "x-yanvah-timestamp",
    "x-yanvah-request-id",
    "x-yanvah-signature",
  ])("missing %s fails closed", async (name) => {
    const { handler, search } = setup();
    const request = signedRequest();
    request.headers.delete(name);
    await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
    expect(search).not.toHaveBeenCalled();
  });

  test.each([
    ["x-yanvah-version", "2"],
    ["x-yanvah-key-id", "unknown-key"],
    ["x-yanvah-timestamp", String(now + 1)],
    ["x-yanvah-request-id", secondRequestId],
    ["x-yanvah-signature", "0".repeat(64)],
    ["x-yanvah-signature", "A".repeat(64)],
    ["x-yanvah-signature", "00"],
    ["x-yanvah-signature", "g".repeat(64)],
    ["x-yanvah-timestamp", "0" + String(now)],
    ["x-yanvah-timestamp", "9007199254740992"],
    ["x-yanvah-request-id", "sensitive-invalid-request-id"],
  ])("tampered/malformed %s=%s is rejected", async (name, value) => {
    const { handler, search } = setup();
    const request = signedRequest();
    request.headers.set(name, value);
    const result = await expectError(
      await handler(request),
      401,
      "AUTHENTICATION_FAILED",
    );
    if (
      name === "x-yanvah-request-id" &&
      value === "sensitive-invalid-request-id"
    ) {
      expect(result.requestId).not.toBe(value);
    }
    expect(search).not.toHaveBeenCalled();
  });

  test.each([
    "x-yanvah-version",
    "x-yanvah-key-id",
    "x-yanvah-timestamp",
    "x-yanvah-request-id",
    "x-yanvah-signature",
  ])("combined duplicate %s values are rejected", async (name) => {
    const { handler, search } = setup();
    const request = signedRequest();
    request.headers.append(name, request.headers.get(name) ?? "");
    await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
    expect(search).not.toHaveBeenCalled();
  });

  test.each([
    { keyId: "different-registered-product" },
    { secret: "another-products-secret-at-least-32-bytes" },
    { version: "3" },
  ])(
    "valid HMAC with incompatible connection values fails: %j",
    async (options) => {
      const { handler, search } = setup();
      await expectError(
        await handler(signedRequest(options)),
        401,
        "AUTHENTICATION_FAILED",
      );
      expect(search).not.toHaveBeenCalled();
    },
  );

  test.each([
    '{ "operation": "users.search", "input": { "query": "john@example.com" } }',
    '{"operation":"users.search","input":{"query":"someone-else"}}',
  ])(
    "body changes invalidate the signature, including equivalent JSON",
    async (body) => {
      const { handler, search } = setup();
      const original = signedRequest();
      const request = new Request(original.url, {
        method: "POST",
        headers: original.headers,
        body,
      });
      await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("correctly signed JSON whitespace and key ordering are preserved", async () => {
    const { handler } = setup();
    expect(
      (
        await handler(
          signedRequest({
            body: '{ "input": {"query":"john@example.com"}, "operation": "users.search" }',
          }),
        )
      ).status,
    ).toBe(200);
  });

  test.each(["/api/yanvah-control/", "/different", "/api/%79anvah-control"])(
    "path tampering to %s invalidates the signature",
    async (path) => {
      const { handler, search } = setup();
      const original = signedRequest();
      const request = new Request(`https://product.example${path}`, {
        method: "POST",
        headers: original.headers,
        body: await original.text(),
      });
      await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("properly signed unsupported methods cannot invoke operations", async () => {
    const { handler, search } = setup();
    await expectError(
      await handler(signedRequest({ method: "PUT" })),
      400,
      "OPERATION_UNSUPPORTED",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test("method tampering invalidates a POST signature", async () => {
    const { handler, search } = setup();
    const original = signedRequest();
    const request = new Request(original.url, {
      method: "PUT",
      headers: original.headers,
      body: await original.text(),
    });
    await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
    expect(search).not.toHaveBeenCalled();
  });

  test("authentication precedes parsing operation data", async () => {
    const { handler } = setup();
    const request = signedRequest({
      body: "{broken",
      secret: "incorrect-secret-at-least-32-bytes",
    });
    await expectError(await handler(request), 401, "AUTHENTICATION_FAILED");
  });

  test("valid request IDs are echoed with their original letter case", async () => {
    const { handler } = setup();
    const incomingId = requestId.toUpperCase();
    const response = controlResponseSchema.parse(
      await (await handler(signedRequest({ requestId: incomingId }))).json(),
    );
    expect(response.requestId).toBe(incomingId);
  });
});

describe("timestamp and replay protection", () => {
  test.each([-300_001, 300_001])(
    "timestamp offset %i is expired",
    async (offset) => {
      const { handler, search } = setup();
      await expectError(
        await handler(signedRequest({ timestamp: String(now + offset) })),
        401,
        "REQUEST_EXPIRED",
      );
      expect(search).not.toHaveBeenCalled();
    },
  );

  test.each([-300_000, 300_000])(
    "timestamp boundary %i remains acceptable",
    async (offset) => {
      const { handler } = setup();
      expect(
        (await handler(signedRequest({ timestamp: String(now + offset) })))
          .status,
      ).toBe(200);
    },
  );

  test("configured zero tolerance requires the current timestamp", async () => {
    const { handler } = setup({ timestampToleranceMs: 0 });
    await expectError(
      await handler(signedRequest({ timestamp: String(now - 1) })),
      401,
      "REQUEST_EXPIRED",
    );
    expect((await handler(signedRequest())).status).toBe(200);
  });

  test("simultaneous copies execute the business function only once", async () => {
    const { handler, search } = setup();
    const responses = await Promise.all([
      handler(signedRequest()),
      handler(signedRequest()),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const replay = responses.find((response) => response.status === 409);
    if (!replay) throw new Error("Missing replay rejection");
    await expectError(replay, 409, "REQUEST_REPLAYED");
    expect(search).toHaveBeenCalledOnce();
  });

  test("unauthenticated requests cannot consume a legitimate request ID", async () => {
    const { handler, search } = setup();
    await expectError(
      await handler(
        signedRequest({ secret: "incorrect-secret-at-least-32-bytes" }),
      ),
      401,
      "AUTHENTICATION_FAILED",
    );
    expect((await handler(signedRequest())).status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
  });

  test("authenticated invalid input consumes its request ID", async () => {
    const { handler } = setup();
    await expectError(
      await handler(signedRequest({ body: "{" })),
      400,
      "INVALID_INPUT",
    );
    await expectError(await handler(signedRequest()), 409, "REQUEST_REPLAYED");
  });

  test("future timestamps retain replay protection through the final accepted millisecond", async () => {
    const consume = vi.fn(() => Promise.resolve(true));
    const { handler } = setup({ replayStore: { consume } });
    expect(
      (await handler(signedRequest({ timestamp: String(now + 300_000) })))
        .status,
    ).toBe(200);
    expect(consume).toHaveBeenCalledWith(requestId, new Date(now + 600_001));
  });

  test("custom stores receive canonical UUIDs so letter case cannot bypass replay protection", async () => {
    const consume = vi.fn(() => Promise.resolve(true));
    const { handler } = setup({ replayStore: { consume } });
    expect(
      (await handler(signedRequest({ requestId: requestId.toUpperCase() })))
        .status,
    ).toBe(200);
    expect(consume).toHaveBeenCalledWith(requestId, new Date(now + 300_001));
  });

  test.each([undefined, null, "true", 1])(
    "nonboolean replay store result %s fails closed",
    async (value) => {
      const replayStore = createMemoryReplayStore();
      Object.defineProperty(replayStore, "consume", {
        value: () => Promise.resolve(value),
      });
      const { handler, search } = setup({ replayStore });
      await expectError(
        await handler(signedRequest()),
        503,
        "PRODUCT_UNAVAILABLE",
      );
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("a synchronous replay store exception is sanitized", async () => {
    const { handler, search } = setup({
      replayStore: {
        consume() {
          throw new Error("secret-database-connection-string");
        },
      },
    });
    const result = await expectError(
      await handler(signedRequest()),
      503,
      "PRODUCT_UNAVAILABLE",
    );
    expect(JSON.stringify(result)).not.toContain(
      "secret-database-connection-string",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test("store rejection fails closed and hides backend errors", async () => {
    const { handler, search } = setup({
      replayStore: {
        consume: () => Promise.reject(new Error(`database-password ${secret}`)),
      },
    });
    const response = await handler(signedRequest());
    const result = await expectError(response, 503, "PRODUCT_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("database-password");
    expect(search).not.toHaveBeenCalled();
  });

  test("the timestamp is checked again after slow replay storage", async () => {
    const { handler, search } = setup({
      timestampToleranceMs: 100,
      replayStore: {
        consume: () => {
          vi.setSystemTime(now + 101);
          return Promise.resolve(true);
        },
      },
    });
    await expectError(await handler(signedRequest()), 401, "REQUEST_EXPIRED");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("request parsing and body limits", () => {
  test.each([
    "{",
    "null",
    "[]",
    "true",
    "{}",
    '{"operation":1,"input":{}}',
    '{"operation":"users.search"}',
  ])("malformed JSON/envelopes are rejected: %s", async (body) => {
    const { handler, search } = setup();
    await expectError(
      await handler(signedRequest({ body })),
      400,
      "INVALID_INPUT",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test("malformed UTF-8 cannot be silently replaced during decoding", async () => {
    const body = Buffer.concat([
      Buffer.from('{"operation":"users.search","input":{"query":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}}'),
    ]);
    const { handler, search } = setup();
    await expectError(
      await handler(signedRequest({ body })),
      400,
      "INVALID_INPUT",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test("prototype-pollution-shaped input cannot reach handlers", async () => {
    const { handler, search } = setup();
    await expectError(
      await handler(
        signedRequest({
          body: '{"operation":"users.search","input":{"query":"john","__proto__":{"admin":true}}}',
        }),
      ),
      400,
      "INVALID_INPUT",
    );
    expect(search).not.toHaveBeenCalled();
  });

  test.each([null, "1", "1000000"])(
    "actual bytes enforce the body limit with Content-Length=%s",
    async (length) => {
      const { handler, search } = setup({ maxBodyBytes: 64 });
      const request = signedRequest({ body: " ".repeat(65) });
      if (length !== null) request.headers.set("content-length", length);
      await expectError(await handler(request), 400, "INVALID_INPUT");
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("body size counts UTF-8 bytes, including multibyte characters", async () => {
    const body = JSON.stringify({
      operation: "users.search",
      input: { query: "é".repeat(10) },
    });
    const { handler } = setup({ maxBodyBytes: body.length });
    await expectError(
      await handler(signedRequest({ body })),
      400,
      "INVALID_INPUT",
    );
  });

  test("a body at the byte limit succeeds", async () => {
    const body = JSON.stringify({
      operation: "users.search",
      input: { query: "john" },
    });
    const { handler } = setup({ maxBodyBytes: Buffer.byteLength(body) });
    expect((await handler(signedRequest({ body }))).status).toBe(200);
  });

  test.each(["1", "500", "invalid", "1, 1"])(
    "inconsistent or malformed Content-Length %s is rejected",
    async (length) => {
      const { handler, search } = setup();
      const request = signedRequest();
      request.headers.set("content-length", length);
      await expectError(await handler(request), 400, "INVALID_INPUT");
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("oversized streams are canceled before reading the remainder", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel,
    });
    const { handler, search } = setup({ maxBodyBytes: 64 });
    await expectError(
      await handler(streamingRequest(body)),
      400,
      "INVALID_INPUT",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });

  test("stream read failures are sanitized", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("sensitive-stream-failure"));
      },
    });
    const { handler, search } = setup();
    const result = await expectError(
      await handler(streamingRequest(body)),
      400,
      "INVALID_INPUT",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive-stream-failure");
    expect(search).not.toHaveBeenCalled();
  });

  test("already consumed bodies cannot execute a handler", async () => {
    const request = signedRequest();
    await request.text();
    const { handler, search } = setup();
    await expectError(await handler(request), 400, "INVALID_INPUT");
    expect(search).not.toHaveBeenCalled();
  });

  test("an already locked body cannot execute a handler", async () => {
    const request = signedRequest();
    const reader = request.body?.getReader();
    const { handler, search } = setup();
    try {
      await expectError(await handler(request), 400, "INVALID_INPUT");
      expect(search).not.toHaveBeenCalled();
    } finally {
      reader?.releaseLock();
    }
  });

  test.each([
    "text/plain",
    "application/json; charset=iso-8859-1",
    "application/json, text/plain",
  ])(
    "unsupported Content-Type %s cannot invoke handlers",
    async (contentType) => {
      const { handler, search } = setup();
      const request = signedRequest();
      request.headers.set("content-type", contentType);
      await expectError(await handler(request), 400, "INVALID_INPUT");
      expect(search).not.toHaveBeenCalled();
    },
  );

  test("missing Content-Type cannot invoke a handler", async () => {
    const { handler, search } = setup();
    const request = signedRequest();
    request.headers.delete("content-type");
    await expectError(await handler(request), 400, "INVALID_INPUT");
    expect(search).not.toHaveBeenCalled();
  });

  test("compressed bodies are rejected instead of decoded after signing", async () => {
    const { handler, search } = setup();
    const request = signedRequest();
    request.headers.set("content-encoding", "gzip");
    await expectError(await handler(request), 400, "INVALID_INPUT");
    expect(search).not.toHaveBeenCalled();
  });

  test("UTF-8 JSON media type parameters are accepted", async () => {
    const { handler } = setup();
    const request = signedRequest();
    request.headers.set("content-type", "application/json; charset=utf-8");
    expect((await handler(request)).status).toBe(200);
  });

  test("query strings are rejected without reflecting their contents", async () => {
    const { handler } = setup();
    const result = await expectError(
      await handler(
        signedRequest({
          url: "https://product.example/api/yanvah-control?secret=query-secret-marker",
        }),
      ),
      400,
      "INVALID_INPUT",
    );
    expect(JSON.stringify(result)).not.toContain("query-secret-marker");
  });

  test.each(["?", "#", "#fragment"])(
    "endpoint URL suffix %s is rejected",
    async (suffix) => {
      const { handler, search } = setup();
      await expectError(
        await handler(
          signedRequest({
            url: `https://product.example/api/yanvah-control${suffix}`,
          }),
        ),
        400,
        "INVALID_INPUT",
      );
      expect(search).not.toHaveBeenCalled();
    },
  );
});

describe("exception sanitization", () => {
  test.each(["sync", "async"])(
    "%s business failures expose no sensitive data or logs",
    async (mode) => {
      const error = new Error(`database-password ${secret}`);
      error.stack = "sensitive-stack-trace";
      const logs = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
        vi.spyOn(console, "debug").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
      ];
      const { handler } = setup({
        users: {
          search: () => {
            if (mode === "sync") throw error;
            return Promise.reject(error);
          },
        },
      });
      const request = signedRequest();
      const signature = request.headers.get("x-yanvah-signature");
      const result = await expectError(
        await handler(request),
        500,
        "INTERNAL_ERROR",
      );
      const serialized = JSON.stringify(result);
      for (const value of [
        secret,
        signature,
        "database-password",
        "sensitive-stack-trace",
      ]) {
        if (value) expect(serialized).not.toContain(value);
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );
});

describe("timeout and cancellation", () => {
  test("a synchronous failure after the deadline returns a sanitized timeout", async () => {
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(0);
    let operationSignal: AbortSignal | undefined;
    const { handler } = setup({
      requestTimeoutMs: 50,
      users: {
        search: (_input, context) => {
          operationSignal = context.signal;
          monotonicClock.mockReturnValue(51);
          throw new Error("sensitive-blocking-handler-failure");
        },
      },
    });
    const result = await expectError(
      await handler(signedRequest()),
      504,
      "REQUEST_TIMEOUT",
    );
    expect(JSON.stringify(result)).not.toContain(
      "sensitive-blocking-handler-failure",
    );
    expect(operationSignal?.aborted).toBe(true);
    expect(Date.now()).toBe(now);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("immediately available empty chunks cannot evade the body read deadline", async () => {
    let elapsed = 0;
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        elapsed += 10;
        if (reads === 100) controller.close();
        else controller.enqueue(new Uint8Array());
      },
      cancel,
    });
    const { handler, search } = setup({ requestTimeoutMs: 50 });
    await expectError(
      await handler(streamingRequest(body)),
      504,
      "REQUEST_TIMEOUT",
    );
    expect(reads).toBeLessThan(100);
    expect(cancel).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
    expect(Date.now()).toBe(now);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a hung handler times out and aborts its operation signal", async () => {
    let operationSignal: AbortSignal | undefined;
    const { handler } = setup({
      requestTimeoutMs: 50,
      users: {
        search: (_input, context) => {
          operationSignal = context.signal;
          return new Promise(() => {});
        },
      },
    });
    const response = handler(signedRequest());
    await vi.advanceTimersByTimeAsync(50);
    await expectError(await response, 504, "REQUEST_TIMEOUT");
    expect(operationSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an already-aborted request never executes a handler", async () => {
    const controller = new AbortController();
    controller.abort(new Error("sensitive-abort-reason"));
    const { handler, search } = setup();
    const result = await expectError(
      await handler(signedRequest({ signal: controller.signal })),
      504,
      "REQUEST_TIMEOUT",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive-abort-reason");
    expect(search).not.toHaveBeenCalled();
  });

  test("request cancellation reaches a running business function", async () => {
    const controller = new AbortController();
    const started = deferred<AbortSignal>();
    const { handler } = setup({
      users: {
        search: (_input, context) => {
          started.resolve(context.signal);
          return new Promise(() => {});
        },
      },
    });
    const response = handler(signedRequest({ signal: controller.signal }));
    const signal = await started.promise;
    controller.abort();
    await expectError(await response, 504, "REQUEST_TIMEOUT");
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("timed-out replay storage cannot later trigger a mutation", async () => {
    const stored = deferred<boolean>();
    const ban = vi.fn(() => {});
    const { handler } = setup({
      requestTimeoutMs: 50,
      replayStore: { consume: () => stored.promise },
      users: { ban },
    });
    const response = handler(
      signedRequest({
        body: JSON.stringify({
          operation: "users.ban",
          input: { userId: user.id },
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    await expectError(await response, 504, "REQUEST_TIMEOUT");
    stored.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ban).not.toHaveBeenCalled();
  });

  test("timeout cancels a stalled body stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { handler, search } = setup({ requestTimeoutMs: 50 });
    const response = handler(streamingRequest(body));
    await vi.advanceTimersByTimeAsync(50);
    await expectError(await response, 504, "REQUEST_TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });

  test("a stalled stream cancellation hook cannot prevent a timeout response", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { handler } = setup({ requestTimeoutMs: 50 });
    const response = handler(streamingRequest(body));
    await vi.advanceTimersByTimeAsync(50);
    await expectError(await response, 504, "REQUEST_TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("completed requests release their timeout", async () => {
    const { handler } = setup();
    expect((await handler(signedRequest())).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});
