import { z } from "zod";

import { errorCodeSchema } from "../errors/codes.js";
import { errorDetails } from "../errors/responses.js";
import { requestIdSchema } from "../internal/schemas.js";

const clientErrorCodeSchema = z.union([
  errorCodeSchema,
  z.enum(["INVALID_RESPONSE", "REQUEST_ABORTED"]),
]);

export type ControlClientErrorCode = z.infer<typeof clientErrorCodeSchema>;

/** A sanitized local or remote failure. The request ID supports safe correlation. */
export class ControlClientError extends Error {
  override readonly name = "ControlClientError";
  readonly code: ControlClientErrorCode;
  readonly requestId: string;

  constructor(code: ControlClientErrorCode, requestId: string) {
    const parsedCode = clientErrorCodeSchema.safeParse(code);
    const parsedId = requestIdSchema.safeParse(requestId);
    if (!parsedCode.success || !parsedId.success) {
      throw new TypeError("Invalid Control client error.");
    }
    const validatedCode = parsedCode.data;
    const message =
      validatedCode === "INVALID_RESPONSE"
        ? "The product returned an invalid response."
        : validatedCode === "REQUEST_ABORTED"
          ? "The request was aborted by the caller."
          : errorDetails[validatedCode].message;
    super(message);
    this.code = validatedCode;
    this.requestId = parsedId.data;
  }
}
