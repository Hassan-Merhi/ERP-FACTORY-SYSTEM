import { describe, expect, it } from "vitest";
import { countStandaloneIdentifierOccurrences } from "../scripts/lib/countStandaloneIdentifierOccurrences.mjs";

describe("dead-code report identifier counting", () => {
  it("counts exact standalone matches without mistaking prefixes and suffixes", () => {
    const source = "const value = value + valueExtra; // value\n";
    expect(countStandaloneIdentifierOccurrences(source, "value")).toBe(3);
  });

  it("recognizes dollar-prefixed identifier names with existing ASCII boundaries", () => {
    expect(countStandaloneIdentifierOccurrences("$rate $rate2 rate$ $rate", "$rate")).toBe(2);
  });

  it("does not count names embedded in an identifier", () => {
    expect(countStandaloneIdentifierOccurrences("foo-bar, bar, foo_bar, $bar, bar$", "bar")).toBe(2);
  });

  it("treats regular-expression metacharacters as literal text", () => {
    expect(countStandaloneIdentifierOccurrences("a.b aXb a.b.b", "a.b")).toBe(2);
    expect(countStandaloneIdentifierOccurrences("fee[1] fee1 fee[1]", "fee[1]")).toBe(2);
  });

  it("handles empty inputs and repeated names without constructing regular expressions", () => {
    expect(countStandaloneIdentifierOccurrences("", "value")).toBe(0);
    expect(countStandaloneIdentifierOccurrences("value", "")).toBe(0);
    expect(countStandaloneIdentifierOccurrences("a a a", "a")).toBe(3);
  });
});
