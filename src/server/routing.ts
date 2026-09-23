import { SDK_VERSION } from "../internal/version.js";
import type { OperationName, ProtocolVersion } from "../protocol/constants.js";
import type { ControlRequest } from "../protocol/envelopes.js";
import { capabilitiesSchema, jsonValueSchema } from "../protocol/models.js";
import type { Capabilities } from "../protocol/models.js";
import { operationResultSchemas } from "../protocol/operations.js";
import type { ValidatedOptions } from "./config.js";
import type { ControlHandlerContext } from "./types.js";

export function createCapabilities(
  options: ValidatedOptions,
  protocolVersion: ProtocolVersion,
): Capabilities {
  const operations: OperationName[] = ["system.capabilities"];
  if (protocolVersion === "2" && options.users?.create)
    operations.push("users.create");
  if (options.users?.search) operations.push("users.search");
  if (options.users?.get) operations.push("users.get");
  if (options.users?.ban) operations.push("users.ban");
  if (options.users?.unban) operations.push("users.unban");
  if (options.users?.revokeSessions) operations.push("users.revokeSessions");
  if (options.subscriptions?.get) operations.push("subscriptions.get");
  if (options.subscriptions?.changePlan)
    operations.push("subscriptions.changePlan");
  const actions = [...(options.actions ?? [])].map(([id, action]) => ({
    id,
    label: action.label,
    description: action.description,
    risk: action.risk,
  }));
  if (actions.length > 0) operations.push("actions.invoke");
  return capabilitiesSchema.parse({
    product: options.product,
    sdkVersion: SDK_VERSION,
    protocolVersion,
    operations,
    actions,
  });
}

type InvocationResult =
  { data: unknown } | { error: "INVALID_INPUT" | "OPERATION_UNSUPPORTED" };

export async function invokeHandler(
  request: ControlRequest,
  options: ValidatedOptions,
  context: ControlHandlerContext,
  checkDeadline: () => void,
): Promise<InvocationResult> {
  switch (request.operation) {
    case "users.create": {
      const handler = options.users?.create;
      if (!handler) break;
      const user = await handler(request.input, context);
      return {
        data: operationResultSchemas["users.create"].parse(
          jsonValueSchema.parse({ user }),
        ),
      };
    }
    case "users.search": {
      const handler = options.users?.search;
      if (!handler) break;
      const limit = request.input.limit ?? 20;
      const users = await handler(
        { query: request.input.query, limit },
        context,
      );
      const result = operationResultSchemas["users.search"].parse(
        jsonValueSchema.parse({ users }),
      );
      if (result.users.length > limit)
        throw new Error("Invalid user search result.");
      return { data: result };
    }
    case "users.get": {
      const handler = options.users?.get;
      if (!handler) break;
      const userId = request.input.userId;
      const user = await handler(request.input, context);
      const result = operationResultSchemas["users.get"].parse(
        jsonValueSchema.parse({ user }),
      );
      if (result.user !== null && result.user.id !== userId) {
        throw new Error("Invalid user lookup result.");
      }
      return { data: result };
    }
    case "users.ban":
      if (options.users?.ban) {
        await options.users.ban(request.input, context);
        return { data: null };
      }
      break;
    case "users.unban":
      if (options.users?.unban) {
        await options.users.unban(request.input, context);
        return { data: null };
      }
      break;
    case "users.revokeSessions":
      if (options.users?.revokeSessions) {
        await options.users.revokeSessions(request.input, context);
        return { data: null };
      }
      break;
    case "subscriptions.get": {
      const handler = options.subscriptions?.get;
      if (!handler) break;
      const userId = request.input.userId;
      const subscription = await handler(request.input, context);
      const result = operationResultSchemas["subscriptions.get"].parse(
        jsonValueSchema.parse({ subscription }),
      );
      if (
        result.subscription !== null &&
        result.subscription.userId !== userId
      ) {
        throw new Error("Invalid subscription lookup result.");
      }
      return { data: result };
    }
    case "subscriptions.changePlan":
      if (options.subscriptions?.changePlan) {
        await options.subscriptions.changePlan(request.input, context);
        return { data: null };
      }
      break;
    case "actions.invoke": {
      const action = options.actions?.get(request.input.actionId);
      if (!action) break;
      let input: unknown = request.input.input;
      if (action.input) {
        const parsed = await action.input.safeParseAsync(input);
        // A schema may await I/O; never start the action after its deadline.
        checkDeadline();
        if (!parsed.success) return { error: "INVALID_INPUT" };
        input = parsed.data;
      }
      const result: unknown = await action.run(input, context);
      return { data: jsonValueSchema.parse(result) };
    }
  }
  return { error: "OPERATION_UNSUPPORTED" };
}
