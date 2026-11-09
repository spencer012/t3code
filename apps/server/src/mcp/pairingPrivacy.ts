import * as DateTime from "effect/DateTime";

/** Saved-connection tool inputs carry pairing credentials that must not enter logs or the transcript. */
export function redactPairingData(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current !== "object" || DateTime.isDateTime(current))
      return current;
    if (depth > 32) return "[REDACTED: depth limit]";
    const existing = seen.get(current);
    if (existing !== undefined) return existing;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(visit(item, depth + 1));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    const savedConnectionTool = ["toolName", "tool", "name"].some((key) => {
      const name = Reflect.get(current, key);
      return typeof name === "string" && name.includes("t3_saved_connection_add");
    });
    for (const [key, nested] of Object.entries(current)) {
      result[key] =
        key === "pairingUrl" ||
        key === "partial_json" ||
        (savedConnectionTool && ["input", "arguments", "rawInput"].includes(key))
          ? "[REDACTED]"
          : visit(nested, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
