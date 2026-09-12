import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile repair Phase 1 critical flows", () => {
  it("keeps desktop split panes while stacking the critical legacy flows only below md", () => {
    const compat = source("client/src/mobile-browser-compat.css");
    const boundary = source("client/src/components/ui/workspace-route-boundary.tsx");
    const erpShell = source("client/src/app/ErpShell.tsx");

    expect(compat).toContain("@media (max-width: 767px) {");
    expect(compat).toContain('[data-workspace-route^="/agents"]');
    expect(compat).toContain('[data-workspace-route^="/factory/agents"]');
    expect(compat).toContain('[data-workspace-route^="/account-groups"]');
    expect(compat).toContain('[data-workspace-route^="/chat"]');
    expect(compat).toContain('[data-workspace-route^="/factory/chat"]');
    expect(compat).toContain("flex-direction: column !important");
    expect(compat).toContain("Tablet/desktop layout remains untouched because these overrides stop at md.");
    expect(boundary).toContain("data-workspace-route={routeKey}");
    expect(boundary).toContain("routeKey={resetKey}");
    expect(erpShell).toContain("data-workspace-route={routePath}");
    expect(erpShell).toContain("data-erp-route={routePath}");
  });

  it("uses Firefox-baseline-safe selectors for the critical phone layouts", () => {
    const compat = source("client/src/mobile-browser-compat.css");

    // The rule is about selectors, so the comments explaining why :has() is
    // avoided must not themselves trip it — a whole-file substring check counts
    // the prose as a violation and fails on a file that is actually compliant.
    const withoutComments = compat.replace(/\/\*[\s\S]*?\*\//g, "");

    expect(withoutComments).not.toContain(":has(");
    expect(compat).toContain("documented Firefox 110+ baseline");
  });

  it("uses bounded local list panes and keeps long chat history internally scrollable", () => {
    const compat = source("client/src/mobile-browser-compat.css");

    expect(compat).toContain("max-height: min(42dvh, 22rem)");
    expect(compat).toContain("max-height: min(44dvh, 24rem)");
    expect(compat).toContain("max-height: min(36dvh, 20rem)");
    expect(compat).toContain("height: calc(var(--app-viewport-height) - 7rem) !important");
    expect(compat).toContain("max-height: calc(var(--app-viewport-height) - 7rem)");
    expect(compat).toContain("min-height: 0");
    expect(compat).toContain("overflow: hidden");
  });

  it("keeps the responsive contracts anchored to the current Agents, Account Groups, and Chat markup", () => {
    // The Agents page was split into pages/agents/* modules; the anchor markup
    // (test ids and pane classes) now lives in the list/statement panels.
    const agentList = source("client/src/pages/agents/AgentListPanel.tsx");
    const agentStatement = source("client/src/pages/agents/AgentStatementPanel.tsx");
    const groups = source("client/src/pages/AccountGroups.tsx");
    const chat = source("client/src/pages/Chat.tsx");

    expect(agentList).toContain('data-testid="button-add-agent"');
    expect(agentStatement).toContain('data-testid="text-agent-account-name"');
    expect(agentList).toContain('className="w-72 shrink-0');

    expect(groups).toContain('data-testid="button-create-group"');
    expect(groups).toContain('className="w-72 border-r flex flex-col shrink-0"');

    expect(chat).toContain('data-testid="chat-page"');
    expect(chat).toContain('className="w-64 shrink-0 flex flex-col"');
  });

  it("makes hover-hidden interactive actions visible to coarse pointers without changing desktop hover behavior", () => {
    const compat = source("client/src/mobile-browser-compat.css");
    const rawStock = source("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");

    expect(compat).toContain("@media (max-width: 767px), (pointer: coarse)");
    expect(compat).toContain('[class*="opacity-0"][class*="group-hover:opacity-100"]');
    expect(compat).toContain("opacity: 1 !important");

    expect(rawStock).toContain("opacity-0 group-hover:opacity-100");
    expect(rawStock).toContain("data-testid={`button-adjust-${row.supplierId}`}");
    expect(rawStock).toContain("data-testid={`button-deduct-${row.supplierId}`}");
    expect(rawStock).toContain("data-testid={`button-batch-${row.supplierId}`}");
  });
});
