/**
 * Narrowing primitives for system boundaries.
 *
 * Values that arrive from a request body, a JSON column, an external API, or a
 * raw SQL row are genuinely `unknown`. The safe move is to keep them `unknown`
 * and narrow them here rather than assert them into a domain type, so a shape
 * that does not match is rejected instead of silently mis-read downstream.
 *
 * These are deliberately small and runtime-independent so both the client and
 * the server can import them without pulling in a driver or a framework.
 */

/** True when `value` can be indexed by string without throwing. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an indexable record, or `undefined` when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** True for a string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A finite number from a number or a numeric string, or `undefined`.
 *
 * PostgreSQL returns `numeric`/`decimal` columns as strings, so a quantity or
 * an amount read from a row is legitimately either. Everything else — `null`,
 * `""`, `"abc"`, `NaN`, `Infinity`, booleans — is rejected rather than coerced,
 * because `Number(null)` is `0` and a silent zero is worse than an error.
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A positive integer from a number or numeric string, or `undefined`. Used for row ids. */
export function toPositiveInteger(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
