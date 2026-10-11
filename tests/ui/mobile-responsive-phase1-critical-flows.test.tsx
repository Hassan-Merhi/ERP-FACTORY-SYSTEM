import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceConsistencyBoundary } from "@/components/ui/workspace-route-boundary";

/**
 * Phase 1 contract for the critical legacy master/detail flows (Agents, Account Groups, Chat):
 * the pages themselves carry their phone stacking as `max-md:` classes, so the rendered markup
 * is what is checked, and the shared stylesheet is checked only for what it must not contain.
 */
function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

afterEach(cleanup);

const stackedBelowMd = (el: HTMLElement) => {
  expect(el.className).toContain("max-md:flex-col");
};
const boundedPane = (el: HTMLElement, cap: string) => {
  expect(el.className).toContain("max-md:w-full");
  expect(el.className).toContain(`max-md:max-h-[${cap}]`);
  expect(el.className).toContain("max-md:flex-none");
  expect(el.className).toContain("max-md:border-b");
};

describe("Mobile repair Phase 1 critical flows", () => {
  it("marks each workspace route so page-level layout can key off a stable attribute", () => {
    render(
      <WorkspaceConsistencyBoundary routeKey="/agents">
        <p>page</p>
      </WorkspaceConsistencyBoundary>
    );
    expect(screen.getByText("page").closest("[data-workspace-route]")).toHaveAttribute(
      "data-workspace-route",
      "/agents"
    );
  });

  it("stacks the Agents panes below md and keeps the fixed master pane on desktop", async () => {
    const { AgentListPanel } = await import("@/pages/agents/AgentListPanel");
    const { AgentStatementPanel } = await import("@/pages/agents/AgentStatementPanel");
    expect(typeof AgentListPanel).toBe("function");
    expect(typeof AgentStatementPanel).toBe("function");

    const agents = source("client/src/pages/Agents.tsx");
    const list = source("client/src/pages/agents/AgentListPanel.tsx");
    const statement = source("client/src/pages/agents/AgentStatementPanel.tsx");
    // Desktop keeps the fixed master pane; below md it is a bounded pane above the statement.
    expect(agents).toContain("flex h-full max-md:h-auto max-md:min-h-full max-md:flex-col");
    expect(list).toContain("w-72 shrink-0 border-r flex flex-col h-full overflow-hidden bg-muted/20 max-md:w-full");
    expect(list).toContain("max-md:max-h-[min(42dvh,22rem)]");
    expect(statement).toContain("p-6 space-y-5 max-w-5xl max-md:p-3");
    expect(list).toContain('data-testid="button-add-agent"');
    expect(statement).toContain('data-testid="text-agent-account-name"');
  });

  it("stacks Account Groups below md with a bounded group list", () => {
    const groups = source("client/src/pages/AccountGroups.tsx");
    const page = document.createElement("div");
    page.innerHTML = `<div class="${groups.match(/className="(flex h-\[calc\(100dvh-73px\)\][^"]*)"/)?.[1]}">
      <div class="${groups.match(/className="(w-72 border-r flex flex-col shrink-0[^"]*)"/)?.[1]}"></div>
      <div class="${groups.match(/className="(flex-1 overflow-y-auto p-6[^"]*)"/)?.[1]}"></div>
    </div>`;
    const split = page.firstElementChild as HTMLElement;
    stackedBelowMd(split);
    expect(split.className).toContain("max-md:h-auto");
    boundedPane(split.children[0] as HTMLElement, "min(44dvh,24rem)");
    expect((split.children[1] as HTMLElement).className).toContain("max-md:p-3");
    expect(groups).toContain('data-testid="button-create-group"');
  });

  it("keeps the Chat thread internally scrollable below md with a bounded conversation list", () => {
    const chat = source("client/src/pages/Chat.tsx");
    const pageClass = chat.match(/className="(h-\[calc\(100dvh-6rem\)\] flex gap-3[^"]*)"/)?.[1] ?? "";
    const listClass = chat.match(/className="(w-64 shrink-0 flex flex-col[^"]*)"/)?.[1] ?? "";
    const threadClass = chat.match(/className="(flex-1 flex flex-col max-md[^"]*)"/)?.[1] ?? "";
    const page = document.createElement("div");
    page.className = pageClass;
    stackedBelowMd(page);
    expect(page.className).toContain("max-md:h-[calc(var(--app-viewport-height)-7rem)]");
    expect(page.className).toContain("max-md:max-h-[calc(var(--app-viewport-height)-7rem)]");
    expect(page.className).toContain("max-md:min-h-0");
    expect(page.className).toContain("max-md:overflow-hidden");
    expect(listClass).toContain("max-md:w-full");
    expect(listClass).toContain("max-md:max-h-[min(36dvh,20rem)]");
    expect(listClass).toContain("max-md:flex-none");
    expect(threadClass).toContain("max-md:min-h-0");
    expect(threadClass).toContain("max-md:overflow-hidden");
    expect(chat).toContain('data-testid="chat-page"');
  });

  it("keeps the shared mobile stylesheet free of page layout and class-string selectors", () => {
    const compat = source("client/src/mobile-browser-compat.css");
    const withoutComments = compat.replace(/\/\*[\s\S]*?\*\//g, "");

    // Page layout lives on the pages; the shared stylesheet never names a route.
    expect(withoutComments).not.toContain("[data-workspace-route");
    expect(withoutComments).not.toContain("chat-page");
    // No substring matches on Tailwind class strings, and nothing outside the documented
    // Firefox 110+ baseline (no :has()).
    expect(withoutComments).not.toContain("[class*=");
    expect(withoutComments).not.toContain(":has(");
    expect(compat).toContain("documented Firefox 110+ baseline");
  });

  it("makes hover-hidden row actions visible to coarse pointers through the touch variant", () => {
    const css = source("client/src/index.css");
    const rawStock = source("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");

    // A custom variant with a doubled selector, so it out-ranks width variants on the same element.
    expect(css).toContain("@custom-variant touch {");
    expect(css).toContain("@media (hover: none) and (pointer: coarse) {\n    &:is(&) {");
    expect(rawStock).toContain("opacity-0 group-hover:opacity-100 touch:opacity-100");
    expect(rawStock).toContain("data-testid={`button-adjust-${row.supplierId}`}");
    expect(rawStock).toContain("data-testid={`button-deduct-${row.supplierId}`}");
    expect(rawStock).toContain("data-testid={`button-batch-${row.supplierId}`}");
  });
});
