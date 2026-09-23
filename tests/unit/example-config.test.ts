import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { readExampleCredentials } from "../../examples/nextjs/config.ts";

const secretA = "example-product-a-secret-at-least-32-bytes";
const secretB = "example-product-b-secret-at-least-32-bytes";

beforeEach(() => {
  vi.stubEnv("PRODUCT_A_KEY_ID", "example-a");
  vi.stubEnv("PRODUCT_A_SECRET", secretA);
  vi.stubEnv("PRODUCT_B_KEY_ID", "example-b");
  vi.stubEnv("PRODUCT_B_SECRET", secretB);
});

afterEach(() => vi.unstubAllEnvs());

test("reads separate credentials without needing public or default secrets", () => {
  expect(readExampleCredentials()).toEqual({
    productA: { keyId: "example-a", secret: secretA },
    productB: { keyId: "example-b", secret: secretB },
  });
});

test.each([
  ["PRODUCT_A_KEY_ID", undefined],
  ["PRODUCT_A_SECRET", undefined],
  ["PRODUCT_B_KEY_ID", undefined],
  ["PRODUCT_B_SECRET", undefined],
  ["PRODUCT_A_KEY_ID", "invalid key"],
  ["PRODUCT_A_SECRET", "too-short"],
  ["PRODUCT_B_SECRET", " ".repeat(40)],
  ["PRODUCT_B_KEY_ID", "example-a"],
  ["PRODUCT_B_SECRET", secretA],
] satisfies [string, string | undefined][])(
  "rejects missing, invalid, or shared credentials in %s",
  (key, value) => {
    vi.stubEnv(key, value);
    expect(readExampleCredentials).toThrow(
      "Configure distinct example credentials in .env.local; run npm run example:setup.",
    );
  },
);
