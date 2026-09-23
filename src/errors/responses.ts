import type { ControlErrorResponse } from "../protocol/envelopes.js";
import type { ErrorCode } from "./codes.js";

export const errorDetails = {
  AUTHENTICATION_FAILED: {
    status: 401,
    message: "Request authentication failed.",
  },
  REQUEST_EXPIRED: {
    status: 401,
    message: "The request timestamp is outside the allowed window.",
  },
  REQUEST_REPLAYED: {
    status: 409,
    message: "This request has already been used.",
  },
  INVALID_INPUT: { status: 400, message: "The request input is invalid." },
  OPERATION_UNSUPPORTED: {
    status: 400,
    message: "This product does not support the requested operation.",
  },
  USER_ALREADY_EXISTS: {
    status: 409,
    message: "A user with this email already exists.",
  },
  PRODUCT_UNAVAILABLE: {
    status: 503,
    message: "The product is temporarily unavailable.",
  },
  REQUEST_TIMEOUT: {
    status: 504,
    message: "The request was canceled or timed out.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "The request could not be completed.",
  },
} satisfies Record<ErrorCode, { status: number; message: string }>;

export function errorResponse(requestId: string, code: ErrorCode): Response {
  const { status, message } = errorDetails[code];
  const body: ControlErrorResponse = {
    ok: false,
    requestId,
    error: { code, message },
  };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
