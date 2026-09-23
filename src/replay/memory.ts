import { z } from "zod";

import { requestIdSchema } from "../internal/schemas.js";
import type { ReplayStore } from "./types.js";

const optionsSchema = z.strictObject({
  maxEntries: z.number().int().min(1).max(1_000_000).optional(),
});

const consumeSchema = z.strictObject({
  requestId: requestIdSchema,
  expiresAt: z.date(),
});

export interface MemoryReplayStoreOptions {
  maxEntries?: number;
}

/**
 * Process-local replay protection with a default capacity of 10,000 IDs.
 * State is lost on restart; distributed/serverless deployments need a shared store.
 */
export function createMemoryReplayStore(
  options: MemoryReplayStoreOptions = {},
): ReplayStore {
  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new Error("Invalid replay store configuration.");
  }

  const maxEntries = parsedOptions.data.maxEntries ?? 10_000;
  const entries = new Map<string, number>();

  return {
    consume(requestId: string, expiresAt: Date): Promise<boolean> {
      const parsed = consumeSchema.safeParse({ requestId, expiresAt });
      const now = Date.now();
      if (!parsed.success || parsed.data.expiresAt.getTime() <= now) {
        return Promise.reject(new Error("Invalid replay claim."));
      }

      for (const [id, expiration] of entries) {
        if (expiration <= now) entries.delete(id);
      }

      const id = parsed.data.requestId.toLowerCase();
      if (entries.has(id)) return Promise.resolve(false);
      if (entries.size >= maxEntries) {
        return Promise.reject(new Error("Replay store capacity exceeded."));
      }

      // Claim synchronously so concurrent requests cannot both observe a missing ID.
      entries.set(id, parsed.data.expiresAt.getTime());
      return Promise.resolve(true);
    },
  };
}
