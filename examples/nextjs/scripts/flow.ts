import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  CONTROL_HEADERS,
  V1_OPERATION_NAMES,
  PROTOCOL_VERSION,
  controlErrorResponseSchema,
} from "@yanvah/control";
import type { ErrorCode } from "@yanvah/control";
import {
  ControlClientError,
  createControlClient,
} from "@yanvah/control/client";
import type { ControlClient } from "@yanvah/control/client";
import { z } from "zod";

interface Connection {
  keyId: string;
  secret: string;
}

interface SmokeOptions {
  origin: string;
  productA: Connection;
  productB: Connection;
  onStep?: (message: string) => void;
}

const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    !url.href.includes("?") &&
    !url.href.includes("#")
  );
});

function signedDiscovery(
  endpoint: string,
  connection: Connection,
  timestamp = Date.now(),
): Request {
  const body = JSON.stringify({ operation: "system.capabilities", input: {} });
  const requestId = randomUUID();
  // Independent signing makes these checks exercise the published wire contract.
  const canonical = [
    PROTOCOL_VERSION,
    connection.keyId,
    String(timestamp),
    requestId,
    "POST",
    new URL(endpoint).pathname,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CONTROL_HEADERS.version]: PROTOCOL_VERSION,
      [CONTROL_HEADERS.keyId]: connection.keyId,
      [CONTROL_HEADERS.timestamp]: String(timestamp),
      [CONTROL_HEADERS.requestId]: requestId,
      [CONTROL_HEADERS.signature]: createHmac("sha256", connection.secret)
        .update(canonical)
        .digest("hex"),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
}

async function expectWireError(
  request: Request,
  code: ErrorCode,
  status: number,
): Promise<void> {
  const response = await fetch(request);
  assert.equal(response.status, status);
  const body: unknown = await response.json();
  const envelope = controlErrorResponseSchema.parse(body);
  assert.equal(
    envelope.requestId,
    request.headers.get(CONTROL_HEADERS.requestId),
  );
  assert.equal(envelope.error.code, code);
  assert.equal(
    envelope.error.message,
    new ControlClientError(code, envelope.requestId).message,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function expectClientError(
  work: Promise<unknown>,
  code: ErrorCode,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, code);
    assert.equal(
      error.message,
      new ControlClientError(code, error.requestId).message,
    );
    return true;
  });
}

async function checkUnavailableProduct(
  connection: Connection,
  healthy: ControlClient,
): Promise<void> {
  // Own this unavailable endpoint so smoke never shuts down a contributor's server.
  const unavailable = createServer((request) => request.socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      unavailable.once("error", reject);
      unavailable.listen(0, "127.0.0.1", resolve);
    });
    const address = unavailable.address();
    assert.ok(address !== null && typeof address !== "string");
    const client = createControlClient({
      ...connection,
      endpoint: `http://127.0.0.1:${address.port}/api/secondary-control`,
      timeoutMs: 1_000,
    });
    await Promise.all([
      expectClientError(client.getCapabilities(), "PRODUCT_UNAVAILABLE"),
      healthy
        .invoke("users.search", { query: "john@example.com" })
        .then((result) => {
          assert.equal(result.users[0]?.id, "user_123");
        }),
    ]);
  } finally {
    unavailable.closeAllConnections();
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
  }
}

/** Exercises only the local fake SaaS, restoring its original ban flag and plan. */
export async function runSmoke(options: SmokeOptions): Promise<void> {
  const parsedOrigin = originSchema.safeParse(options.origin);
  if (!parsedOrigin.success) {
    throw new Error(
      "Smoke requires an http://127.0.0.1 origin without a path.",
    );
  }
  const origin = new URL(parsedOrigin.data).origin;
  const endpointA = `${origin}/api/yanvah-control`;
  const endpointB = `${origin}/api/secondary-control`;
  const productA = createControlClient({
    endpoint: endpointA,
    ...options.productA,
  });
  const productB = createControlClient({
    endpoint: endpointB,
    ...options.productB,
  });
  const step = options.onStep ?? (() => undefined);

  const [capabilitiesA, capabilitiesB] = await Promise.all([
    productA.getCapabilities(),
    productB.getCapabilities(),
  ]);
  // Check fixture identity before any mutation; this script is not a production probe.
  assert.equal(capabilitiesA.product.id, "product-a");
  assert.equal(capabilitiesB.product.id, "product-b");
  assert.deepEqual(capabilitiesA.operations, [...V1_OPERATION_NAMES]);
  assert.deepEqual(capabilitiesB.operations, [
    "system.capabilities",
    "users.search",
    "users.get",
    "subscriptions.get",
  ]);
  assert.equal(capabilitiesA.actions[0]?.id, "grant-free-pro");
  assert.equal(capabilitiesA.actions[0]?.risk, "dangerous");
  assert.deepEqual(capabilitiesB.actions, []);
  step("Discovered both products and their different capabilities.");

  const [searchA, searchB] = await Promise.all([
    productA.invoke("users.search", { query: "john@example.com" }),
    productB.invoke("users.search", { query: "john@example.com" }),
  ]);
  assert.equal(searchA.users.length, 1);
  assert.equal(searchB.users.length, 1);
  assert.equal(searchA.users[0]?.id, "user_123");
  assert.equal(searchB.users[0]?.id, "user_123");
  const [
    { user: originalUser },
    originalUserB,
    { subscription: originalPlan },
    originalPlanB,
  ] = await Promise.all([
    productA.invoke("users.get", { userId: "user_123" }),
    productB.invoke("users.get", { userId: "user_123" }),
    productA.invoke("subscriptions.get", { userId: "user_123" }),
    productB.invoke("subscriptions.get", { userId: "user_123" }),
  ]);
  assert.ok(originalUser !== null && typeof originalUser.banned === "boolean");
  assert.ok(originalPlan !== null);
  assert.equal(originalUser.email, "john@example.com");
  assert.equal(originalUserB.user?.email, "john@example.com");
  assert.ok(originalPlanB.subscription !== null);
  step("Searched and inspected the same email in both products.");

  try {
    assert.equal(
      await productA.invoke("users.ban", {
        userId: "user_123",
        reason: "Local smoke test",
      }),
      null,
    );
    assert.equal(
      (await productA.invoke("users.get", { userId: "user_123" })).user?.banned,
      true,
    );
    assert.deepEqual(
      await productB.invoke("users.get", { userId: "user_123" }),
      originalUserB,
    );
    step("Banned Product A's user without changing Product B.");

    assert.equal(
      await productA.invoke("users.unban", { userId: "user_123" }),
      null,
    );
    assert.equal(
      (await productA.invoke("users.get", { userId: "user_123" })).user?.banned,
      false,
    );
    step("Unbanned Product A's user.");

    assert.equal(
      await productA.invoke("users.revokeSessions", { userId: "user_123" }),
      null,
    );
    step("Revoked the fake user's sessions.");

    assert.equal(
      await productA.invoke("subscriptions.changePlan", {
        userId: "user_123",
        planId: "pro",
      }),
      null,
    );
    assert.equal(
      (await productA.invoke("subscriptions.get", { userId: "user_123" }))
        .subscription?.planId,
      "pro",
    );
    assert.deepEqual(
      await productB.invoke("subscriptions.get", { userId: "user_123" }),
      originalPlanB,
    );
    step("Changed Product A's plan without changing Product B.");

    await productA.invoke("subscriptions.changePlan", {
      userId: "user_123",
      planId: "basic",
    });
    const grant = z
      .strictObject({
        userId: z.literal("user_123"),
        planId: z.literal("pro"),
        days: z.literal(7),
        currentPeriodEnd: z.iso.datetime({ precision: 3 }),
      })
      .parse(
        await productA.invoke("actions.invoke", {
          actionId: "grant-free-pro",
          input: { userId: "user_123", days: 7 },
        }),
      );
    const { subscription: grantedPlan } = await productA.invoke(
      "subscriptions.get",
      { userId: "user_123" },
    );
    assert.ok(grantedPlan !== null);
    assert.equal(grantedPlan.planId, "pro");
    assert.equal(grantedPlan.currentPeriodEnd, grant.currentPeriodEnd);
    assert.deepEqual(
      await productB.invoke("subscriptions.get", { userId: "user_123" }),
      originalPlanB,
    );
    step("Ran the schema-validated grant-free-pro action.");

    const modified = signedDiscovery(endpointA, options.productA);
    const signature = modified.headers.get(CONTROL_HEADERS.signature);
    assert.ok(signature);
    modified.headers.set(
      CONTROL_HEADERS.signature,
      (signature[0] === "0" ? "1" : "0") + signature.slice(1),
    );
    await expectWireError(modified, "AUTHENTICATION_FAILED", 401);
    step("Rejected a modified signature.");

    await expectWireError(
      signedDiscovery(endpointA, options.productA, Date.now() - 600_000),
      "REQUEST_EXPIRED",
      401,
    );
    step("Rejected an expired signed request.");

    const first = signedDiscovery(endpointA, options.productA);
    const replay = first.clone();
    const accepted = await fetch(first);
    assert.equal(accepted.status, 200);
    await accepted.arrayBuffer();
    await expectWireError(replay, "REQUEST_REPLAYED", 409);
    step("Rejected a replayed request ID.");

    await expectClientError(
      productB.invoke("users.ban", { userId: "user_123" }),
      "OPERATION_UNSUPPORTED",
    );
    await expectClientError(
      createControlClient({
        endpoint: endpointA,
        ...options.productB,
      }).getCapabilities(),
      "AUTHENTICATION_FAILED",
    );
    assert.deepEqual(
      await productB.invoke("users.get", { userId: "user_123" }),
      originalUserB,
    );
    step("Rejected unregistered mutations and another product's credentials.");

    await checkUnavailableProduct(options.productB, productA);
    step(
      "An unavailable product failed cleanly while Product A stayed responsive.",
    );
  } finally {
    await Promise.all([
      productA.invoke(originalUser.banned ? "users.ban" : "users.unban", {
        userId: "user_123",
      }),
      productA.invoke("subscriptions.changePlan", {
        userId: "user_123",
        planId: originalPlan.planId,
      }),
    ]);
  }
  step("Restored Product A's original ban flag and plan.");
}
