import type { z } from "zod";

import type {
  ActionCapability,
  Actor,
  JsonValue,
  Product,
  Subscription,
  User,
} from "../protocol/models.js";
import type { OperationInput } from "../protocol/operations.js";
import type { ReplayStore } from "../replay/types.js";

export interface ControlHandlerContext {
  requestId: string;
  /** Caller-supplied audit attribution, not independent authorization. */
  actor: Actor | undefined;
  /** Aborted on request cancellation or timeout; callbacks must cooperate. */
  signal: AbortSignal;
}

export interface UsersHandlers {
  /** The SaaS owns defaults and invitations; duplicate errors must mean no account was created. */
  create?: (
    input: OperationInput<"users.create">,
    context: ControlHandlerContext,
  ) => User | Promise<User>;
  search?: (
    input: { query: string; limit: number },
    context: ControlHandlerContext,
  ) => User[] | Promise<User[]>;
  get?: (
    input: OperationInput<"users.get">,
    context: ControlHandlerContext,
  ) => User | null | Promise<User | null>;
  ban?: (
    input: OperationInput<"users.ban">,
    context: ControlHandlerContext,
  ) => void | Promise<void>;
  unban?: (
    input: OperationInput<"users.unban">,
    context: ControlHandlerContext,
  ) => void | Promise<void>;
  revokeSessions?: (
    input: OperationInput<"users.revokeSessions">,
    context: ControlHandlerContext,
  ) => void | Promise<void>;
}

export interface SubscriptionsHandlers {
  get?: (
    input: OperationInput<"subscriptions.get">,
    context: ControlHandlerContext,
  ) => Subscription | null | Promise<Subscription | null>;
  changePlan?: (
    input: OperationInput<"subscriptions.changePlan">,
    context: ControlHandlerContext,
  ) => void | Promise<void>;
}

export type ActionDefinition<Schema = unknown> = Omit<
  ActionCapability,
  "id"
> & {
  // Infer each inline schema before requiring it for a schema-typed callback below.
  input?: Schema & z.ZodType;
  run: (
    input: Schema extends z.ZodType ? z.output<Schema> : JsonValue,
    context: ControlHandlerContext,
  ) => JsonValue | Promise<JsonValue>;
} & (Schema extends z.ZodType ? { input: Schema } : { input?: undefined });

export interface ControlHandlerOptions<
  ActionSchemas extends Record<string, unknown> = Record<string, unknown>,
> {
  product: Product;
  /** Use an independent secret per connection, as literal UTF-8 text (32–1024 bytes). */
  auth: { keyId: string; secret: string };
  /** Must atomically claim IDs across every worker serving this connection. */
  replayStore: ReplayStore;
  users?: UsersHandlers;
  subscriptions?: SubscriptionsHandlers;
  actions?: {
    [Id in keyof ActionSchemas]: ActionDefinition<ActionSchemas[Id]>;
  };
  /** Inclusive clock-skew window in milliseconds; default/max 300,000. */
  timestampToleranceMs?: number;
  /** Maximum received body bytes; default 65,536, maximum 1,048,576. */
  maxBodyBytes?: number;
  /** Deadline for body reading, replay storage, and execution; default 10,000 ms. */
  requestTimeoutMs?: number;
}

export type ControlHandler = (request: Request) => Promise<Response>;
