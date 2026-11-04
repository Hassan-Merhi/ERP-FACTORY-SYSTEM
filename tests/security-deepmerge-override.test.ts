import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const merge = require("../vendor/secure-deepmerge/index.cjs") as
  ((target: unknown, source: unknown, options?: Record<string, unknown>) => any) & {
    all: (parts: unknown[]) => any;
  };

describe("secure Puppeteer Extra deepmerge compatibility", () => {
  it("keeps normal nested objects, array concatenation and the .all API", () => {
    expect(merge({ first: { x: 1 }, list: [1] }, { first: { y: 2 }, list: [2] })).toEqual({
      first: { x: 1, y: 2 },
      list: [1, 2],
    });
    expect(merge.all([{ x: 1 }, { y: 2 }])).toEqual({ x: 1, y: 2 });
  });

  it("never changes the prototype when an attacker supplies __proto__", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"ok":{"value":1}}');
    const output = merge({ safe: true }, input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(output).toEqual({ safe: true, ok: { value: 1 } });
  });

  it("rejects dangerous keys from the target as well as nested sources", () => {
    const target = JSON.parse('{"__proto__":{"poisoned":true},"constructor":{"prototype":{"bad":true}},"x":2}');
    const source = JSON.parse('{"nested":{"__proto__":{"bad":true},"prototype":{"x":1},"ok":7}}');
    const output = merge(target, source);
    expect(output).toEqual({ x: 2, nested: { ok: 7 } });
    expect(Object.getPrototypeOf(output.nested)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("poisoned");
  });

  it("rejects pollution via merging arrays of untrusted objects", () => {
    const output = merge({items: []}, {items:[JSON.parse('{"__proto__":{"foo":1},"good":"yes"}')]});
    expect(output).toEqual({items: [{good:"yes"}]});
    expect(Object.prototype).not.toHaveProperty("foo");
  });
});
