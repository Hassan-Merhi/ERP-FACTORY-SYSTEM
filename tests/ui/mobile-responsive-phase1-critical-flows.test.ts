import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile repair Phase 1 critical flows", () => {
  it("keeps desktop split panes while stacking the critical legacy flows only below md", () => {
    const compat = source("client/src/mobile-browser-compat.css");

    expect(compat).toContain("@media (max-width: 767px) {");
    expect(compat).toContain('[data-testid="button-add-agent"]');
    expect(compat).toContain('[data-testid="button-create-group"]');
    expect(compat).toContain('[data-testid="chat-page"]');
    expect(compat).toContain("flex-direction: column !important");
    expect(compat).toContain("Tablet/desktop layout remains untouched because these overrides stop at md.");
  });

  it("uses bounded local list panes instead of permanent phone-width desktop sidebars", () => {
    const compat = source("client/src/mobile-browser-compat.css");

    expect(compat).toContain("max-height: min(42dvh, 22rem)");
    expect(compat).toContain("max-height: min(44dvh, 24rem)");
    expect(compat).toContain("max-height: min(36dvh, 20rem)");
    expect(compat).toContain("min-height: calc(var(--app-viewport-height) - 7rem)");
  });

  it("keeps the CSS selectors anchored to the current Agents, Account Groups, and Chat markup", () => {
    const agents = source("client/src/pages/Agents.tsx");
    const groups = source("client/src/pages/AccountGroups.tsx");
    const chat = source("client/src/pages/Chat.tsx");

    expect(agents).toContain('data-testid="button-add-agent"');
    expect(agents).toContain('data-testid="text-agent-account-name"');
    expect(agents).toContain('className="w-72 shrink-0');

    expect(groups).toContain('data-testid="button-create-group"');
    expect(groups).toContain('className="w-72 border-r flex flex-col shrink-0"');

    expect(chat).toContain('data-testid="chat-page"');
    expect(chat).toContain('className="w-64 shrink-0 flex flex-col"');
  });

  it("makes hover-hidden interactive actions visible to coarse pointers without changing desktop hover behavior", () => {
    const compat = source("client/src/mobile-browser-compat.css");
    const rawStock = source("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");

    expect(compat).toContain('@media (max-width: 767px), (pointer: coarse)');
    expect(compat).toContain('button, a)[class*="opacity-0"][class*="group-hover:opacity-100"]');
    expect(compat).toContain("opacity: 1 !important");

    expect(rawStock).toContain("opacity-0 group-hover:opacity-100");
    expect(rawStock).toContain('data-testid={`button-adjust-${row.supplierId}`}');
    expect(rawStock).toContain('data-testid={`button-deduct-${row.supplierId}`}');
    expect(rawStock).toContain('data-testid={`button-batch-${row.supplierId}`}');
  });
});
