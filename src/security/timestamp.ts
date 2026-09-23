function parseTimestamp(timestamp: string): number | undefined {
  const value = Number(timestamp);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    String(value) !== timestamp
  ) {
    return undefined;
  }
  return value;
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isTimestampValid(
  timestamp: string,
  now: number,
  toleranceMs: number,
): boolean {
  const value = parseTimestamp(timestamp);
  return (
    value !== undefined &&
    isNonnegativeInteger(now) &&
    isNonnegativeInteger(toleranceMs) &&
    Math.abs(now - value) <= toleranceMs
  );
}

export function replayExpiresAt(timestamp: string, toleranceMs: number): Date {
  const value = parseTimestamp(timestamp);
  if (value === undefined || !isNonnegativeInteger(toleranceMs)) {
    throw new Error("Invalid replay expiration.");
  }

  // The timestamp window is inclusive; retain the ID through its final millisecond.
  const expiresAt = new Date(value + toleranceMs + 1);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid replay expiration.");
  }
  return expiresAt;
}
