import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import autoprefixer from "autoprefixer";
import postcss, { type AtRule, type Rule } from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * Phone action-row wrapping, checked against the compiled stylesheets (what the browser actually
 * receives). Tailwind's `@apply` in index.css copies every rule naming an applied class with the
 * applying class swapped in, so a selector that is correct in source can compile into one that is
 * not. An earlier `:not(.flex-col)` in index.css shipped as `:not(.empty-state)` and wrapped
 * almost every column on phones, growing pages past the viewport.
 */
async function compile(file: string): Promise<postcss.Root> {
  const from = resolve(process.cwd(), file);
  const result = await postcss([tailwindcss(), autoprefixer()]).process(readFileSync(from, "utf8"), { from });
  return result.root;
}

type WrapRule = { selector: string; value: string; media: string };

function wrapRules(root: postcss.Root): WrapRule[] {
  const found: WrapRule[] = [];
  root.walkRules((rule: Rule) => {
    rule.walkDecls("flex-wrap", (decl) => {
      let media = "";
      let parent: Rule["parent"] = rule.parent;
      while (parent && parent.type !== "root") {
        if (parent.type === "atrule" && (parent as AtRule).name === "media") media += (parent as AtRule).params;
        parent = parent.parent;
      }
      found.push({ selector: rule.selector, value: decl.value, media });
    });
  });
  return found;
}

function element(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

const phoneWrapRules = (rules: WrapRule[]) =>
  rules.filter((r) => r.value === "wrap" && r.media.includes("max-width: 767px"));

const matchesAny = (rules: WrapRule[], el: Element) =>
  rules.filter((r) => {
    try {
      return el.matches(r.selector);
    } catch {
      return false;
    }
  });

describe("phone action-row wrapping (compiled CSS)", () => {
  it("wraps button rows but never columns or nowrap rows", async () => {
    const compat = wrapRules(await compile("client/src/mobile-browser-compat.css"));
    const phone = phoneWrapRules(compat);
    expect(phone.length).toBeGreaterThan(0);

    // Rows of controls wrap.
    expect(matchesAny(phone, element("flex items-center gap-2"))).not.toHaveLength(0);
    expect(matchesAny(phone, element("flex justify-end gap-3"))).not.toHaveLength(0);
    // A column that becomes a row at sm/md wraps too (it is a row when the rule is relevant).
    expect(matchesAny(phone, element("flex flex-col gap-3 sm:flex-row"))).not.toHaveLength(0);
    // Columns and explicit nowrap rows keep a single line.
    expect(matchesAny(phone, element("flex flex-col gap-4"))).toHaveLength(0);
    expect(matchesAny(phone, element("flex min-w-0 max-w-full flex-col gap-4 sm:gap-5"))).toHaveLength(0);
    expect(matchesAny(phone, element("flex flex-nowrap gap-2 overflow-auto"))).toHaveLength(0);
    expect(matchesAny(phone, element("flex flex-col gap-2 lg:flex-row"))).toHaveLength(0);
  }, 60_000);

  it("compiles index.css without a wrap rule that catches plain columns", async () => {
    const index = wrapRules(await compile("client/src/index.css"));
    const phone = phoneWrapRules(index);
    for (const el of [
      element("flex flex-col gap-4"),
      element("flex flex-col gap-3 empty-state"),
      element("flex flex-nowrap gap-2"),
    ]) {
      expect(matchesAny(phone, el).map((r) => r.selector)).toEqual([]);
    }
  }, 120_000);
});
