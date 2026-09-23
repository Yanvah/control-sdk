import { describe, expect, it } from "vitest";

import {
  createCanonicalRequest,
  hashBody,
  signRequest,
  verifyRequestSignature,
} from "../../src/security/signature.js";
import type { SignedRequestFields } from "../../src/security/signature.js";
import {
  isTimestampValid,
  replayExpiresAt,
} from "../../src/security/timestamp.js";

const encoder = new TextEncoder();
const fields: SignedRequestFields = {
  version: "1",
  keyId: "example-key",
  timestamp: "1789819200000",
  requestId: "7a1aaed4-b884-4d9c-8148-c5c79be928c6",
  method: "POST",
  pathname: "/api/yanvah-control",
};
const body = encoder.encode('{"operation":"system.capabilities","input":{}}');
const secret = "test-only-32-byte-secret-value!!!";
const expectedBodyHash =
  "b09ac4c22f2e3ff5292a8125fcfc87a8111e3b1def0063b49a4b4b8d8072b54a";
// Independently calculated with Web Crypto's HMAC implementation.
const expectedSignature =
  "551f3a81ec332db4a7c073e8b894603b3cea949d63826d160a4966d03182effa";

describe("canonical request signatures", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("matches the SHA-256 test vector for %j", (input, expected) => {
    expect(hashBody(encoder.encode(input))).toBe(expected);
  });

  it("constructs the exact seven-line canonical string without a trailing LF", () => {
    expect(createCanonicalRequest(fields, body)).toBe(
      "1\nexample-key\n1789819200000\n7a1aaed4-b884-4d9c-8148-c5c79be928c6\nPOST\n/api/yanvah-control\n" +
        expectedBodyHash,
    );
  });

  it("matches an independently generated HMAC-SHA256 signature", () => {
    expect(signRequest(fields, body, secret)).toBe(expectedSignature);
    expect(
      verifyRequestSignature(fields, body, secret, expectedSignature),
    ).toBe(true);
  });

  it("hashes a Uint8Array view without unrelated backing-buffer bytes", () => {
    const backing = encoder.encode("xabcx");
    expect(hashBody(backing.subarray(1, 4))).toBe(
      hashBody(encoder.encode("abc")),
    );
  });

  it.each([
    { version: "2" },
    { keyId: "other-key" },
    { timestamp: "1789819200001" },
    { requestId: "7a1aaed4-b884-4d9c-8148-c5c79be928c7" },
    { requestId: fields.requestId.toUpperCase() },
    { method: "PUT" },
    { pathname: "/api/yanvah-control/" },
    { pathname: "/api/%79anvah-control" },
  ])("rejects changes to signed field %#", (modified) => {
    expect(
      verifyRequestSignature(
        { ...fields, ...modified },
        body,
        secret,
        expectedSignature,
      ),
    ).toBe(false);
  });

  it.each([
    '{ "operation": "system.capabilities", "input": {} }',
    '{"input":{},"operation":"system.capabilities"}',
    '{"operation":"system.capabilities","input":{}}\n',
    '{"operation":"users.get","input":{}}',
  ])(
    "rejects modified bytes even when JSON has equivalent meaning: %s",
    (input) => {
      expect(
        verifyRequestSignature(
          fields,
          encoder.encode(input),
          secret,
          expectedSignature,
        ),
      ).toBe(false);
    },
  );

  it("rejects a different secret", () => {
    expect(
      verifyRequestSignature(
        fields,
        body,
        "different-secret",
        expectedSignature,
      ),
    ).toBe(false);
  });

  it("treats secrets as literal UTF-8, without hexadecimal decoding", () => {
    const literal = "616263";
    expect(signRequest(fields, body, literal)).not.toBe(
      signRequest(fields, body, "abc"),
    );
    expect(signRequest(fields, body, "sëcret 🔐")).not.toBe(
      signRequest(fields, body, "secret"),
    );
  });

  it.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    expectedSignature.toUpperCase(),
    `${expectedSignature}\n`,
    `sha256=${expectedSignature}`,
    ` ${expectedSignature}`,
    `${expectedSignature},${expectedSignature}`,
    "0".repeat(64),
    "0" + expectedSignature.slice(1),
    expectedSignature.slice(0, -1) + "0",
  ])(
    "rejects malformed or unequal signature %# without throwing",
    (signature) => {
      expect(verifyRequestSignature(fields, body, secret, signature)).toBe(
        false,
      );
    },
  );
});

describe("timestamp acceptance and replay lifetime", () => {
  const now = 1_789_819_200_000;
  const toleranceMs = 300_000;

  it.each([-300_001, -300_000, -1, 0, 1, 300_000, 300_001])(
    "enforces an inclusive clock window at offset %i",
    (offset) => {
      expect(isTimestampValid(String(now + offset), now, toleranceMs)).toBe(
        Math.abs(offset) <= toleranceMs,
      );
    },
  );

  it("supports zero tolerance and the epoch", () => {
    expect(isTimestampValid("0", 0, 0)).toBe(true);
    expect(isTimestampValid(String(now), now, 0)).toBe(true);
    expect(isTimestampValid(String(now + 1), now, 0)).toBe(false);
  });

  it.each([
    "",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e3",
    "Infinity",
    "NaN",
    "9007199254740992",
    "123\n",
    " 123",
  ])("rejects malformed or imprecise timestamp %j", (timestamp) => {
    expect(isTimestampValid(timestamp, now, toleranceMs)).toBe(false);
    expect(() => replayExpiresAt(timestamp, toleranceMs)).toThrow(
      "Invalid replay expiration.",
    );
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid clock or tolerance %s",
    (value) => {
      expect(isTimestampValid(String(now), value, toleranceMs)).toBe(false);
      expect(isTimestampValid(String(now), now, value)).toBe(false);
      expect(() => replayExpiresAt(String(now), value)).toThrow();
    },
  );

  it("retains a future-dated request through its full acceptance window", () => {
    const timestamp = now + toleranceMs;
    const expiration = replayExpiresAt(
      String(timestamp),
      toleranceMs,
    ).getTime();
    expect(expiration).toBe(now + 2 * toleranceMs + 1);
    expect(
      isTimestampValid(String(timestamp), expiration - 1, toleranceMs),
    ).toBe(true);
    expect(isTimestampValid(String(timestamp), expiration, toleranceMs)).toBe(
      false,
    );
  });

  it("retains an ID for the accepted millisecond when tolerance is zero", () => {
    expect(replayExpiresAt(String(now), 0).getTime()).toBe(now + 1);
  });

  it("rejects expiration values outside the Date range", () => {
    expect(() => replayExpiresAt("8640000000000000", 0)).toThrow();
    expect(() => replayExpiresAt(String(Number.MAX_SAFE_INTEGER), 0)).toThrow();
  });
});
