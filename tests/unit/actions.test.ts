import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { controlResponseSchema } from "../../src/index.js";
import {
  createControlHandler,
  createMemoryReplayStore,
  type ControlHandler,
  type ControlHandlerOptions,
} from "../../src/server/index.js";
import { subscription, user } from "../fixtures.js";
import {
  keyId,
  now,
  product,
  requestId,
  secret,
  signedRequest,
} from "../helpers/signed-request.js";

function options(): ControlHandlerOptions {
  return {
    product,
    auth: { keyId, secret },
    replayStore: createMemoryReplayStore(),
  };
}

function untypedHandler(configuration: unknown): ControlHandler {
  const handler: unknown = Reflect.apply(createControlHandler, undefined, [
    configuration,
  ]);
  return z
    .custom<ControlHandler>((value) => typeof value === "function")
    .parse(handler);
}

async function invoke(
  handler: ControlHandler,
  operation: string,
  input: unknown,
) {
  const response = await handler(
    signedRequest({ body: JSON.stringify({ operation, input }) }),
  );
  return { response, body: controlResponseSchema.parse(await response.json()) };
}

const metadata = {
  label: "Grant Pro",
  description: "Grant complimentary access.",
  risk: "dangerous",
} as const;
const grantInput = z.strictObject({
  userId: z.string().min(1),
  days: z.int().min(1).max(90),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscription handlers", () => {
  test.each([subscription, null])(
    "lookup returns a matching subscription or null",
    async (record) => {
      const get = vi.fn(() => Promise.resolve(record));
      const handler = createControlHandler({
        ...options(),
        subscriptions: { get },
      });
      const result = await invoke(handler, "subscriptions.get", {
        userId: user.id,
      });
      expect(result.body).toEqual({
        ok: true,
        requestId,
        data: { subscription: record },
      });
      expect(get).toHaveBeenCalledWith(
        { userId: user.id },
        expect.objectContaining({ requestId }),
      );
    },
  );

  test("plan changes receive validated input and normalize to null", async () => {
    const changePlan = vi.fn(() => Promise.resolve());
    const handler = createControlHandler({
      ...options(),
      subscriptions: { changePlan },
    });
    expect(
      (
        await invoke(handler, "subscriptions.changePlan", {
          userId: user.id,
          planId: "enterprise",
        })
      ).body,
    ).toEqual({ ok: true, requestId, data: null });
    expect(changePlan).toHaveBeenCalledWith(
      { userId: user.id, planId: "enterprise" },
      expect.objectContaining({ requestId }),
    );
  });

  test.each([
    { operation: "subscriptions.get", input: {} },
    { operation: "subscriptions.get", input: { userId: " " } },
    { operation: "subscriptions.get", input: { userId: user.id, extra: true } },
    { operation: "subscriptions.changePlan", input: { userId: user.id } },
    {
      operation: "subscriptions.changePlan",
      input: { userId: user.id, planId: 10 },
    },
    {
      operation: "subscriptions.changePlan",
      input: { userId: user.id, planId: " " },
    },
  ])(
    "invalid $operation input never runs a subscription handler",
    async ({ operation, input }) => {
      const get = vi.fn(() => subscription);
      const changePlan = vi.fn(() => {});
      const handler = createControlHandler({
        ...options(),
        subscriptions: { get, changePlan },
      });
      expect((await invoke(handler, operation, input)).body).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
      expect(get).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
    },
  );

  test.each([
    { ...subscription, userId: "another-user" },
    { ...subscription, status: "unknown" },
    { ...subscription, secret: "private-database-value" },
    { ...subscription, currentPeriodEnd: "yesterday" },
  ])("invalid subscription results are sanitized", async (record) => {
    const handler = untypedHandler({
      ...options(),
      subscriptions: { get: () => record },
    });
    const { response, body } = await invoke(handler, "subscriptions.get", {
      userId: user.id,
    });
    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(body)).not.toContain("private-database-value");
  });

  test("mutating callback input cannot bypass subscription ownership validation", async () => {
    const handler = createControlHandler({
      ...options(),
      subscriptions: {
        get: (input) => {
          input.userId = "another-user";
          return { ...subscription, userId: input.userId };
        },
      },
    });
    expect(
      (await invoke(handler, "subscriptions.get", { userId: user.id })).body,
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
});

describe("custom action registration and execution", () => {
  test("discovery exposes registered metadata and operations without executable schemas", async () => {
    const handler = createControlHandler({
      ...options(),
      subscriptions: { get: () => null, changePlan: () => {} },
      actions: {
        "grant-pro": { ...metadata, input: grantInput, run: (input) => input },
      },
    });
    expect(
      (await invoke(handler, "system.capabilities", {})).body,
    ).toMatchObject({
      ok: true,
      data: {
        operations: [
          "system.capabilities",
          "subscriptions.get",
          "subscriptions.changePlan",
          "actions.invoke",
        ],
        actions: [{ id: "grant-pro", ...metadata }],
      },
    });
    const empty = createControlHandler({
      ...options(),
      subscriptions: {},
      actions: {},
    });
    expect((await invoke(empty, "system.capabilities", {})).body).toMatchObject(
      { ok: true, data: { operations: ["system.capabilities"], actions: [] } },
    );
  });

  test("schema actions receive parsed output and callback context", async () => {
    const run = vi.fn((input: z.output<typeof grantInput>) =>
      Promise.resolve({ granted: input.days }),
    );
    const handler = createControlHandler({
      ...options(),
      actions: { "grant-pro": { ...metadata, input: grantInput, run } },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "grant-pro",
          input: { userId: user.id, days: 30 },
        })
      ).body,
    ).toEqual({ ok: true, requestId, data: { granted: 30 } });
    expect(run).toHaveBeenCalledWith(
      { userId: user.id, days: 30 },
      expect.objectContaining({
        requestId,
        actor: undefined,
      }),
    );
  });

  test("schema transforms are applied before the callback", async () => {
    const handler = createControlHandler({
      ...options(),
      actions: {
        "grant-pro": {
          ...metadata,
          input: z.string().transform((value) => new Date(value)),
          run: (input) => ({ date: input.toISOString() }),
        },
      },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "grant-pro",
          input: "2026-09-19T12:00:00.000Z",
        })
      ).body,
    ).toEqual({
      ok: true,
      requestId,
      data: { date: "2026-09-19T12:00:00.000Z" },
    });
  });

  test.each([null, false, 1, "input", [1, "two"], { nested: { value: true } }])(
    "actions without schemas accept safe JSON: %j",
    async (input) => {
      const handler = createControlHandler({
        ...options(),
        actions: { echo: { ...metadata, run: (value) => value } },
      });
      expect(
        (await invoke(handler, "actions.invoke", { actionId: "echo", input }))
          .body,
      ).toEqual({ ok: true, requestId, data: input });
    },
  );

  test.each([
    { actionId: "grant-pro", input: { userId: user.id, days: 0 } },
    { actionId: "grant-pro", input: { userId: user.id, days: "30" } },
    {
      actionId: "grant-pro",
      input: { userId: user.id, days: 30, role: "admin" },
    },
    { actionId: "grant-pro", input: {} },
    { actionId: "grant-pro" },
    { actionId: "INVALID", input: null },
    { actionId: "grant-pro", input: JSON.parse('{"__proto__":{}}') as unknown },
  ])("invalid action inputs never invoke a callback", async (input) => {
    const run = vi.fn(() => null);
    const handler = createControlHandler({
      ...options(),
      actions: { "grant-pro": { ...metadata, input: grantInput, run } },
    });
    const { response, body } = await invoke(handler, "actions.invoke", input);
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(run).not.toHaveBeenCalled();
  });

  test.each(["missing", "constructor", "prototype", "tostring"])(
    "unknown action %s is unsupported",
    async (actionId) => {
      const run = vi.fn(() => null);
      const handler = createControlHandler({
        ...options(),
        actions: { "grant-pro": { ...metadata, run } },
      });
      expect(
        (await invoke(handler, "actions.invoke", { actionId, input: {} })).body,
      ).toMatchObject({ ok: false, error: { code: "OPERATION_UNSUPPORTED" } });
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("an explicitly registered prototype-like action ID is routed safely", async () => {
    const handler = createControlHandler({
      ...options(),
      actions: { constructor: { ...metadata, run: () => "registered" } },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "constructor",
          input: null,
        })
      ).body,
    ).toMatchObject({ ok: true, data: "registered" });
  });

  test("action registrations are copied at construction", async () => {
    const run = vi.fn(() => "original");
    const action = { ...metadata, label: "Original", run };
    const actions = { registered: action };
    const handler = createControlHandler({ ...options(), actions });
    action.label = "Changed";
    action.run = vi.fn(() => "replacement");
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "registered",
          input: null,
        })
      ).body,
    ).toMatchObject({ ok: true, data: "original" });
    expect(run).toHaveBeenCalledOnce();
  });

  test.each([
    undefined,
    new Date(),
    Number.NaN,
    { password: undefined },
    () => null,
  ])("non-JSON action output is sanitized", async (value) => {
    const handler = untypedHandler({
      ...options(),
      actions: { invalid: { ...metadata, run: () => value } },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "invalid",
          input: null,
        })
      ).body,
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });

  test("action output accessors are never invoked", async () => {
    const read = vi.fn(() => "sensitive");
    const handler = createControlHandler({
      ...options(),
      actions: {
        invalid: {
          ...metadata,
          run: () => ({
            get secret() {
              return read();
            },
          }),
        },
      },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "invalid",
          input: null,
        })
      ).body,
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(read).not.toHaveBeenCalled();
  });

  test.each(["schema", "callback"])(
    "%s exceptions remain sanitized",
    async (source) => {
      const run = vi.fn(() => {
        throw new Error("sensitive-action-error");
      });
      const input = z.unknown().transform(() => {
        if (source === "schema") throw new Error("sensitive-schema-error");
        return null;
      });
      const handler = createControlHandler({
        ...options(),
        actions: { invalid: { ...metadata, input, run } },
      });
      const { body } = await invoke(handler, "actions.invoke", {
        actionId: "invalid",
        input: null,
      });
      expect(body).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      });
      expect(JSON.stringify(body)).not.toContain("sensitive");
      if (source === "schema") expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("asynchronous action validation", () => {
  test("a schema that exhausts the monotonic deadline cannot start an action", async () => {
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const run = vi.fn(() => null);
    const input = z.string().transform((value) => {
      monotonicClock.mockReturnValue(51);
      return value;
    });
    const handler = createControlHandler({
      ...options(),
      requestTimeoutMs: 50,
      actions: { validate: { ...metadata, input, run } },
    });
    expect(
      (
        await invoke(handler, "actions.invoke", {
          actionId: "validate",
          input: "value",
        })
      ).body,
    ).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT" } });
    expect(run).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "async schema validation returns %s",
    async (valid) => {
      const run = vi.fn(() => "accepted");
      const handler = createControlHandler({
        ...options(),
        actions: {
          validate: {
            ...metadata,
            input: z.string().refine(() => Promise.resolve(valid)),
            run,
          },
        },
      });
      const { body } = await invoke(handler, "actions.invoke", {
        actionId: "validate",
        input: "value",
      });
      expect(body).toMatchObject(
        valid
          ? { ok: true, data: "accepted" }
          : { ok: false, error: { code: "INVALID_INPUT" } },
      );
      expect(run).toHaveBeenCalledTimes(valid ? 1 : 0);
    },
  );

  test.each(["timeout", "cancellation"])(
    "%s prevents a late schema from starting an action",
    async (cause) => {
      let finishValidation: (value: boolean) => void = () => {};
      const started = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishValidation = resolve;
          }),
      );
      const run = vi.fn(() => null);
      const controller = new AbortController();
      const handler = createControlHandler({
        ...options(),
        requestTimeoutMs: 50,
        actions: {
          validate: { ...metadata, input: z.string().refine(started), run },
        },
      });
      const response = handler(
        signedRequest({
          body: JSON.stringify({
            operation: "actions.invoke",
            input: { actionId: "validate", input: "value" },
          }),
          signal: controller.signal,
        }),
      );
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce(), {
        interval: 1,
      });
      if (cause === "timeout") await vi.advanceTimersByTimeAsync(50);
      else controller.abort("private-reason");
      expect(
        controlResponseSchema.parse(await (await response).json()),
      ).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT" } });
      finishValidation(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("action and subscription configuration validation", () => {
  test.each([
    { subscriptions: { get: true } },
    { subscriptions: { changePlan: "callback" } },
    { subscriptions: { refund: () => {} } },
    { actions: { "Invalid ID": { ...metadata, run: () => null } } },
    {
      actions: { invalid: { ...metadata, label: " ", run: (): null => null } },
    },
    { actions: { invalid: { ...metadata, description: "", run: () => null } } },
    {
      actions: { invalid: { ...metadata, risk: "automatic", run: () => null } },
    },
    {
      actions: {
        invalid: {
          label: "Missing risk",
          description: "Description",
          run: (): null => null,
        },
      },
    },
    {
      actions: {
        invalid: {
          ...metadata,
          input: { safeParseAsync: () => ({ success: true }) },
          run: (): null => null,
        },
      },
    },
    { actions: { invalid: { ...metadata, run: "not-a-function" } } },
    {
      actions: {
        invalid: { ...metadata, run: (): null => null, hidden: true },
      },
    },
  ])("rejects invalid registration %j", (invalid) => {
    expect(() => untypedHandler({ ...options(), ...invalid })).toThrow(
      "Invalid Control handler configuration.",
    );
  });

  test.each(["subscriptions", "actions"])(
    "rejects inherited %s registrations",
    (name) => {
      const inherited: object = {};
      Object.setPrototypeOf(
        inherited,
        name === "actions"
          ? { inherited: { ...metadata, run: () => null } }
          : { get: () => subscription },
      );
      expect(() => untypedHandler({ ...options(), [name]: inherited })).toThrow(
        TypeError,
      );
    },
  );

  test("does not register action callbacks inherited from Object.prototype", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "run");
    Object.defineProperty(Object.prototype, "run", {
      value: () => null,
      configurable: true,
    });
    try {
      expect(() =>
        untypedHandler({ ...options(), actions: { invalid: metadata } }),
      ).toThrow(TypeError);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "run", previous);
      else Reflect.deleteProperty(Object.prototype, "run");
    }
  });
});
