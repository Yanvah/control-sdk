import { z } from "zod";

export const ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "REQUEST_EXPIRED",
  "REQUEST_REPLAYED",
  "INVALID_INPUT",
  "OPERATION_UNSUPPORTED",
  "USER_ALREADY_EXISTS",
  "PRODUCT_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
