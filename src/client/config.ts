import { z } from "zod";

import { ownConfiguration } from "../internal/configuration.js";
import { requestHeadersSchema } from "../protocol/envelopes.js";
import { protocolVersionSchema } from "../protocol/constants.js";
import { actorSchema } from "../protocol/models.js";
import type { ControlClientOptions } from "./types.js";

const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      value === value.trim() &&
      !url.username &&
      !url.password &&
      !url.href.includes("?") &&
      !url.href.includes("#") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  })
  .transform((value) => new URL(value).href);

const optionsSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      endpoint: endpointSchema,
      keyId: requestHeadersSchema.shape.keyId,
      secret: z
        .string()
        .regex(/\S/)
        .refine((value) => {
          const bytes = Buffer.byteLength(value, "utf8");
          return bytes >= 32 && bytes <= 1024;
        }),
      protocolVersion: protocolVersionSchema.default("1"),
      timeoutMs: z.int().min(1).max(60_000).default(10_000),
      maxResponseBytes: z.int().min(1).max(10_485_760).default(1_048_576),
      fetch: z
        .custom<typeof globalThis.fetch>((value) => typeof value === "function")
        .optional(),
    })
    .transform((options) => {
      Object.setPrototypeOf(options, null);
      return options;
    }),
);

export const invokeOptionsSchema = z.preprocess(
  ownConfiguration,
  z
    .strictObject({
      actor: actorSchema.optional(),
      signal: z.instanceof(AbortSignal).optional(),
    })
    .transform((options) => {
      Object.setPrototypeOf(options, null);
      return options;
    }),
);

export type ValidatedClientOptions = z.output<typeof optionsSchema>;

export function validateClientOptions(
  options: ControlClientOptions,
): ValidatedClientOptions {
  try {
    return optionsSchema.parse(options);
  } catch {
    throw new TypeError("Invalid Control client configuration.");
  }
}
