/** A definite creation conflict. Only this code is safe to return from a callback. */
export class ControlHandlerError extends Error {
  override readonly name = "ControlHandlerError";
  readonly code = "USER_ALREADY_EXISTS" as const;

  constructor(code: "USER_ALREADY_EXISTS") {
    if (code !== "USER_ALREADY_EXISTS")
      throw new TypeError("Invalid Control handler error.");
    super("A user with this email already exists.");
  }
}
