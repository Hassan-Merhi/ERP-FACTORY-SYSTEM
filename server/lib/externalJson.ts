import { isRecord } from "@shared/typeGuards";

/**
 * Readers for JSON that arrives from outside this system.
 *
 * `Response.json()` resolves to `any`, and third-party tracking payloads have no
 * schema we control: each carrier names the same field differently, and the
 * shapes change without notice. The scrapers responded by declaring their rows
 * `any[]` and reading fields off them, which meant a payload shape change turned
 * into `undefined` flowing silently into a shipment record rather than a miss
 * the caller could see.
 *
 * These keep the value `unknown` and narrow at the point of use, which is what
 * an external boundary warrants. They never throw: an absent or wrongly-typed
 * field reads as `null`/`[]`, exactly what the `??` chains they replace expected.
 */

/** Walk an object/array path, returning `undefined` at the first step that does not exist. */
export function jsonPath(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The value as an array of still-unknown elements, or `[]` when it is not one. */
export function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The first candidate that is neither `null` nor `undefined`.
 *
 * This is deliberately "first defined" rather than "first non-empty", because
 * that is what the `a ?? b ?? fallback` chains it replaces did. Picking the
 * first non-empty candidate would change which field an external payload is
 * read from whenever the primary one is present but blank, and there is no
 * evidence any carrier relies on that - so the behaviour is preserved exactly
 * and the difference is left as a separate question.
 */
export function firstDefined(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

/**
 * The value as a string, or `null` when it is neither a string nor a finite
 * number.
 *
 * Deliberately verbatim: it does not trim, and it does not turn `""` into
 * `null`. Callers read these into slots typed `string | null`, and at least one
 * caller filters on `status !== null`, so collapsing an empty string to `null`
 * would silently drop events that the untyped version kept. Whether a blank
 * field should count as absent is a separate question from typing it.
 */
export function jsonString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
