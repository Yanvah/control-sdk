import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  userSchema,
  type Product,
  type Subscription,
  type User,
} from "@yanvah/control";
import {
  createControlHandler,
  createMemoryReplayStore,
  ControlHandlerError,
  type ControlHandler,
} from "@yanvah/control/server";

interface ExampleProductOptions {
  product: Product;
  auth: { keyId: string; secret: string };
  writable: boolean;
}

interface ExampleProduct {
  handler: ControlHandler;
  state: {
    users: Map<string, User>;
    subscriptions: Map<string, Subscription>;
    sessions: Map<string, number>;
  };
}

const grantFreeProInput = z.strictObject({
  userId: userSchema.shape.id,
  days: z.int().min(1).max(365),
});

export function createExampleProduct(
  options: ExampleProductOptions,
): ExampleProduct {
  // Each connection owns its fake business data and process-local replay store.
  const users = new Map<string, User>([
    [
      "user_123",
      {
        id: "user_123",
        email: "john@example.com",
        name: "John Example",
        banned: false,
      },
    ],
    [
      "user_456",
      {
        id: "user_456",
        email: "alex@example.com",
        name: "Alex Example",
        banned: false,
      },
    ],
  ]);
  const subscriptions = new Map<string, Subscription>(
    [...users.keys()].map((userId) => [
      userId,
      {
        id: `subscription_${userId}`,
        userId,
        planId: "basic",
        status: "active",
        currentPeriodEnd: null,
      },
    ]),
  );
  const sessions = new Map([...users.keys()].map((userId) => [userId, 2]));

  function requireUser(userId: string): User {
    const user = users.get(userId);
    if (!user) throw new Error("Example user was not found.");
    return user;
  }

  function requireSubscription(userId: string): Subscription {
    const subscription = subscriptions.get(userId);
    if (!subscription) throw new Error("Example subscription was not found.");
    return subscription;
  }

  const handler = createControlHandler<{
    "grant-free-pro": typeof grantFreeProInput;
  }>({
    product: options.product,
    auth: options.auth,
    replayStore: createMemoryReplayStore(),
    users: {
      search: ({ query, limit }) => {
        const search = query.toLowerCase();
        return [...users.values()]
          .filter(
            (user) =>
              user.email?.toLowerCase().includes(search) ||
              user.name?.toLowerCase().includes(search),
          )
          .slice(0, limit);
      },
      get: ({ userId }) => users.get(userId) ?? null,
      ...(options.writable
        ? {
            create: ({
              email,
              name,
            }: {
              email: string;
              name?: string | undefined;
            }) => {
              if (
                [...users.values()].some(
                  (user) => user.email?.toLowerCase() === email.toLowerCase(),
                )
              )
                throw new ControlHandlerError("USER_ALREADY_EXISTS");
              const user: User = {
                id: `user_${randomUUID()}`,
                email,
                ...(name ? { name } : {}),
                banned: false,
              };
              users.set(user.id, user);
              return user;
            },
            ban: ({ userId }) => {
              requireUser(userId).banned = true;
            },
            unban: ({ userId }) => {
              requireUser(userId).banned = false;
            },
            revokeSessions: ({ userId }) => {
              requireUser(userId);
              sessions.set(userId, 0);
            },
          }
        : {}),
    },
    subscriptions: {
      get: ({ userId }) => subscriptions.get(userId) ?? null,
      ...(options.writable
        ? {
            changePlan: ({ userId, planId }) => {
              const subscription = requireSubscription(userId);
              subscription.planId = planId;
              subscription.currentPeriodEnd = null;
            },
          }
        : {}),
    },
    ...(options.writable
      ? {
          actions: {
            "grant-free-pro": {
              label: "Grant Free Pro",
              description:
                "Grant a complimentary Pro subscription for 1–365 days.",
              risk: "dangerous",
              input: grantFreeProInput,
              run: ({ userId, days }) => {
                const subscription = requireSubscription(userId);
                const currentPeriodEnd = new Date(
                  Date.now() + days * 86_400_000,
                ).toISOString();
                subscription.planId = "pro";
                subscription.status = "active";
                subscription.currentPeriodEnd = currentPeriodEnd;
                return { userId, planId: "pro", days, currentPeriodEnd };
              },
            },
          },
        }
      : {}),
  });

  return { handler, state: { users, subscriptions, sessions } };
}
