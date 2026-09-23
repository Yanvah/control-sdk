import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryReplayStore } from "../../src/replay/memory.js";
import { replayExpiresAt } from "../../src/security/timestamp.js";

const requestId = "7a1aaed4-b884-4d9c-8148-c5c79be928c6";
const anotherRequestId = "7a1aaed4-b884-4d9c-8148-c5c79be928c7";
const now = 1_789_819_200_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("in-memory replay store", () => {
  it("claims new IDs and rejects replays until expiration", async () => {
    const store = createMemoryReplayStore();
    const expiresAt = new Date(now + 1_000);
    expect(await store.consume(requestId, expiresAt)).toBe(true);
    expect(await store.consume(requestId, expiresAt)).toBe(false);
    expect(await store.consume(anotherRequestId, expiresAt)).toBe(true);
  });

  it("claims concurrently submitted IDs atomically", async () => {
    const store = createMemoryReplayStore();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.consume(requestId, new Date(now + 1_000)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("treats UUID letter-case aliases as the same request", async () => {
    const store = createMemoryReplayStore();
    const expiresAt = new Date(now + 1_000);
    expect(await store.consume(requestId.toUpperCase(), expiresAt)).toBe(true);
    expect(await store.consume(requestId, expiresAt)).toBe(false);
  });

  it("retains IDs through the final accepted timestamp millisecond", async () => {
    const store = createMemoryReplayStore();
    const expiresAt = replayExpiresAt(String(now), 300_000);
    expect(await store.consume(requestId, expiresAt)).toBe(true);
    vi.setSystemTime(expiresAt.getTime() - 1);
    expect(await store.consume(requestId, expiresAt)).toBe(false);
    vi.setSystemTime(expiresAt);
    expect(await store.consume(requestId, new Date(Date.now() + 1))).toBe(true);
  });

  it("copies the expiry value so the caller cannot shorten a claim", async () => {
    const store = createMemoryReplayStore();
    const expiresAt = new Date(now + 1_000);
    await store.consume(requestId, expiresAt);
    expiresAt.setTime(now);
    expect(await store.consume(requestId, new Date(now + 1_000))).toBe(false);
  });

  it("does not shorten an existing claim when a replay has an earlier expiry", async () => {
    const store = createMemoryReplayStore();
    await store.consume(requestId, new Date(now + 1_000));
    expect(await store.consume(requestId, new Date(now + 10))).toBe(false);
    vi.setSystemTime(now + 11);
    expect(await store.consume(requestId, new Date(now + 1_000))).toBe(false);
  });

  it("fails closed at capacity without evicting live IDs", async () => {
    const store = createMemoryReplayStore({ maxEntries: 1 });
    const expiresAt = new Date(now + 1_000);
    await store.consume(requestId, expiresAt);
    await expect(store.consume(anotherRequestId, expiresAt)).rejects.toThrow(
      "Replay store capacity exceeded.",
    );
    expect(await store.consume(requestId, expiresAt)).toBe(false);
  });

  it("reclaims expired capacity without a background timer", async () => {
    const store = createMemoryReplayStore({ maxEntries: 1 });
    await store.consume(requestId, new Date(now + 1));
    vi.setSystemTime(now + 1);
    expect(await store.consume(anotherRequestId, new Date(now + 2))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps separate store instances independent", async () => {
    const first = createMemoryReplayStore();
    const second = createMemoryReplayStore();
    const expiresAt = new Date(now + 1_000);
    expect(await first.consume(requestId, expiresAt)).toBe(true);
    expect(await second.consume(requestId, expiresAt)).toBe(true);
  });

  it.each([
    null,
    [],
    { maxEntries: 0 },
    { maxEntries: -1 },
    { maxEntries: 1.5 },
    { maxEntries: 1_000_001 },
    { maxEntries: Infinity },
    { maxEntries: NaN },
    { maxEntries: "10" },
    { maxEntries: 10, extra: true },
  ])("rejects invalid configuration %#", (options: unknown) => {
    expect(() => {
      Reflect.apply(createMemoryReplayStore, undefined, [options]);
    }).toThrow("Invalid replay store configuration.");
  });

  it.each([
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
    `${requestId}\n`,
  ])("rejects invalid request ID %j", async (id) => {
    const store = createMemoryReplayStore();
    await expect(store.consume(id, new Date(now + 1_000))).rejects.toThrow(
      "Invalid replay claim.",
    );
  });

  it.each([new Date(NaN), new Date(now), new Date(now - 1)])(
    "rejects invalid or elapsed expiry %#",
    async (expiresAt) => {
      const store = createMemoryReplayStore();
      await expect(store.consume(requestId, expiresAt)).rejects.toThrow(
        "Invalid replay claim.",
      );
      expect(await store.consume(requestId, new Date(now + 1))).toBe(true);
    },
  );

  it("rejects non-Date runtime input without storing the ID", async () => {
    const store = createMemoryReplayStore();
    const result: unknown = Reflect.apply(store.consume.bind(store), store, [
      requestId,
      now + 1,
    ]);
    await expect(result).rejects.toThrow("Invalid replay claim.");
    expect(await store.consume(requestId, new Date(now + 1))).toBe(true);
  });
});
