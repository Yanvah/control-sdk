export function ownConfiguration(value: unknown): unknown {
  if (value === null || typeof value !== "object") return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  // Inherited properties must never become credentials or registered callbacks.
  const own: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  Object.setPrototypeOf(own, null);
  return own;
}
