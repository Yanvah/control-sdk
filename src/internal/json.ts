// Reject unsafe keys before Zod can strip them, and bound recursion on untrusted JSON.
export function hasSafeJsonStructure(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth: number = 0,
): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (depth >= 64 || ancestors.has(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      (Array.isArray(value) &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
    ) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      !hasSafeJsonStructure(descriptor.value, ancestors, depth + 1)
    ) {
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}
