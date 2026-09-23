import { describe, expect, it } from "vitest";

import {
  CONTROL_HEADERS,
  ERROR_CODES,
  OPERATION_NAMES,
  controlErrorResponseSchema,
  controlRequestSchema,
  controlResponseSchema,
  controlSuccessResponseSchema,
  operationInputSchemas,
  operationResultSchemas,
  protocolVersionSchema,
  requestHeadersSchema,
} from "../../src/index.js";
import {
  headers,
  jsonRoundTrip,
  requestId,
  requests,
  results,
} from "../fixtures.js";

describe("protocol serialization", () => {
  it.each(OPERATION_NAMES)("round-trips %s requests and responses", (name) => {
    const request = requests[name];
    expect(controlRequestSchema.parse(jsonRoundTrip(request))).toEqual(request);
    expect(operationInputSchemas[name].parse(request.input)).toEqual(
      request.input,
    );

    const response = { ok: true, requestId, data: results[name] };
    const parsed = controlResponseSchema.parse(jsonRoundTrip(response));
    expect(parsed).toEqual(response);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(operationResultSchemas[name].parse(parsed.data)).toEqual(
        results[name],
      );
    }
  });

  it.each(ERROR_CODES)("round-trips normalized %s errors", (code) => {
    const response = {
      ok: false,
      requestId,
      error: { code, message: "The request could not be completed." },
    };
    expect(controlResponseSchema.parse(jsonRoundTrip(response))).toEqual(
      response,
    );
    expect(controlErrorResponseSchema.parse(response)).toEqual(response);
  });

  it("round-trips all required authentication header fields", () => {
    expect(CONTROL_HEADERS).toEqual({
      version: "X-Yanvah-Version",
      keyId: "X-Yanvah-Key-Id",
      timestamp: "X-Yanvah-Timestamp",
      requestId: "X-Yanvah-Request-Id",
      signature: "X-Yanvah-Signature",
    });
    expect(requestHeadersSchema.parse(jsonRoundTrip(headers))).toEqual(headers);
  });

  it("preserves omitted optional fields without inserting defaults", () => {
    const request = { operation: "users.search", input: { query: "john" } };
    expect(controlRequestSchema.parse(request)).toEqual(request);
  });

  it.each(OPERATION_NAMES)(
    "requires input and rejects extra keys for %s",
    (name) => {
      expect(controlRequestSchema.safeParse({ operation: name }).success).toBe(
        false,
      );
      expect(
        controlRequestSchema.safeParse({
          ...requests[name],
          secret: "not-allowed",
        }).success,
      ).toBe(false);
      expect(
        operationInputSchemas[name].safeParse({
          ...requests[name].input,
          extra: true,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    null,
    [],
    {},
    { operation: "users.delete", input: { userId: "u1" } },
    { operation: "constructor", input: {} },
    { operation: "actions.grant-free-pro", input: {} },
    { operation: "users.get", input: { query: "john" } },
    { operation: "users.get", input: { userId: "u1" }, actor: null },
    { operation: "users.get", input: { userId: "u1" }, actor: { id: "" } },
    {
      operation: "users.get",
      input: { userId: "u1" },
      actor: { id: "a", role: "admin" },
    },
    JSON.parse(
      '{"operation":"system.capabilities","input":{},"__proto__":{"polluted":true}}',
    ) as unknown,
    JSON.parse(
      '{"operation":"users.get","input":{"userId":"u1","constructor":{}}}',
    ) as unknown,
  ])("rejects malformed or unsupported request %#", (request: unknown) => {
    expect(controlRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    null,
    {},
    { ok: "true", requestId, data: null },
    { ok: true, requestId },
    { ok: true, requestId: "", data: null },
    { ok: true, requestId, data: undefined },
    { ok: true, requestId, data: NaN },
    { ok: true, requestId, data: new Date("2026-09-19") },
    {
      ok: true,
      requestId,
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Failed" },
    },
    {
      ok: false,
      requestId,
      error: { code: "UNKNOWN_ERROR", message: "Failed" },
    },
    { ok: false, requestId, error: { code: "INTERNAL_ERROR", message: "" } },
    {
      ok: false,
      requestId,
      error: { code: "INTERNAL_ERROR", message: "x".repeat(513) },
    },
    {
      ok: false,
      requestId,
      error: { code: "INTERNAL_ERROR", message: "Failed", stack: "private" },
    },
    {
      ok: false,
      requestId,
      error: { code: "INTERNAL_ERROR", message: "Failed" },
      data: null,
    },
  ])("rejects malformed response %#", (response: unknown) => {
    expect(controlResponseSchema.safeParse(response).success).toBe(false);
  });

  it("requires operation-specific result validation after envelope validation", () => {
    const response = controlSuccessResponseSchema.parse({
      ok: true,
      requestId,
      data: { users: "invalid" },
    });
    expect(
      operationResultSchemas["users.search"].safeParse(response.data).success,
    ).toBe(false);
  });
});

describe("authentication header syntax (not signature verification)", () => {
  it.each(Object.keys(headers))("requires %s", (key) => {
    const incomplete = { ...headers } as Record<string, unknown>;
    delete incomplete[key];
    expect(requestHeadersSchema.safeParse(incomplete).success).toBe(false);
  });

  it.each(["", "3", "01", 1, null])("rejects unknown version %s", (version) => {
    expect(protocolVersionSchema.safeParse(version).success).toBe(false);
    expect(
      requestHeadersSchema.safeParse({ ...headers, version }).success,
    ).toBe(false);
  });

  it.each([
    "-1",
    "01",
    "1.5",
    "1e12",
    " 123",
    "123\n",
    "9007199254740992",
    123,
  ])("rejects invalid timestamp %s", (timestamp) => {
    expect(
      requestHeadersSchema.safeParse({ ...headers, timestamp }).success,
    ).toBe(false);
  });

  it.each([
    { keyId: "" },
    { keyId: "a\nb" },
    { keyId: "key\n" },
    { keyId: "x".repeat(129) },
    { keyId: "a,b" },
    { requestId: "not-a-uuid" },
    { requestId: `${requestId}\n` },
    { requestId: "00000000-0000-0000-0000-000000000000" },
    { signature: "A".repeat(64) },
    { signature: "g".repeat(64) },
    { signature: "a".repeat(63) },
    { signature: "a".repeat(65) },
    { signature: `${"a".repeat(64)}\n` },
    { signature: `sha256=${"a".repeat(64)}` },
    { extra: "value" },
  ])("rejects malformed authentication field %#", (fields) => {
    expect(
      requestHeadersSchema.safeParse({ ...headers, ...fields }).success,
    ).toBe(false);
  });
});
