import type {
  Capabilities,
  ControlRequest,
  OperationName,
  OperationResult,
  RequestHeaders,
  Subscription,
  User,
} from "../src/index.js";

export const requestId = "7a1aaed4-b884-4d9c-8148-c5c79be928c6";

export const headers: RequestHeaders = {
  version: "1",
  keyId: "product-a-key-1",
  timestamp: "1789819200000",
  requestId,
  signature: "a".repeat(64),
};

export const user: User = {
  id: "user_123",
  email: "john@example.com",
  name: "John",
  banned: false,
  createdAt: "2026-09-19T12:00:00.000Z",
};

export const subscription: Subscription = {
  id: "sub_123",
  userId: user.id,
  planId: "pro",
  status: "active",
  currentPeriodEnd: "2026-10-19T12:00:00.000Z",
};

export const capabilities: Capabilities = {
  product: { id: "product-a", name: "Product A" },
  sdkVersion: "0.0.0-phase.1",
  protocolVersion: "1",
  operations: ["system.capabilities", "users.search", "actions.invoke"],
  actions: [
    {
      id: "grant-free-pro",
      label: "Grant Free Pro",
      description: "Grants a complimentary Pro subscription.",
      risk: "dangerous",
    },
  ],
};

export const requests = {
  "system.capabilities": { operation: "system.capabilities", input: {} },
  "users.create": {
    operation: "users.create",
    input: { email: "new@example.com", name: "New User" },
  },
  "users.search": {
    operation: "users.search",
    input: { query: "john@example.com", limit: 20 },
  },
  "users.get": { operation: "users.get", input: { userId: user.id } },
  "users.ban": {
    operation: "users.ban",
    actor: { id: "control-admin", email: "admin@example.com" },
    input: { userId: user.id, reason: "Chargeback abuse" },
  },
  "users.unban": { operation: "users.unban", input: { userId: user.id } },
  "users.revokeSessions": {
    operation: "users.revokeSessions",
    input: { userId: user.id },
  },
  "subscriptions.get": {
    operation: "subscriptions.get",
    input: { userId: user.id },
  },
  "subscriptions.changePlan": {
    operation: "subscriptions.changePlan",
    input: { userId: user.id, planId: "pro" },
  },
  "actions.invoke": {
    operation: "actions.invoke",
    input: { actionId: "grant-free-pro", input: { userId: user.id, days: 30 } },
  },
} satisfies {
  [Name in OperationName]: Extract<ControlRequest, { operation: Name }>;
};

export const results = {
  "system.capabilities": capabilities,
  "users.create": { user },
  "users.search": { users: [user] },
  "users.get": { user },
  "users.ban": null,
  "users.unban": null,
  "users.revokeSessions": null,
  "subscriptions.get": { subscription },
  "subscriptions.changePlan": null,
  "actions.invoke": { granted: true, days: 30 },
} satisfies { [Name in OperationName]: OperationResult<Name> };

export function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
