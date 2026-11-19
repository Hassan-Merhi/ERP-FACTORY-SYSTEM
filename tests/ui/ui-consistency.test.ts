import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 10 UI consistency contracts", () => {
  it("provides shared responsive workspace primitives", () => {
    const layout = source("client/src/components/ui/workspace-layout.tsx");

    for (const primitive of [
      "WorkspacePage",
      "WorkspaceSection",
      "WorkspaceSectionHeader",
      "WorkspaceToolbar",
      "WorkspaceToolbarGroup",
      "WorkspaceActions",
      "ResponsiveTableFrame",
      "FormActionBar",
    ]) {
      expect(layout).toContain(`function ${primitive}`);
    }

    expect(layout).toContain('role="region"');
    expect(layout).toContain("tabIndex={0}");
    expect(layout).toContain("overflow-x-auto");
    expect(layout).toContain("flex-col-reverse");
  });

  it("keeps shared filters and actions contained on phone widths", () => {
    const layout = source("client/src/components/ui/workspace-layout.tsx");

    expect(layout).toContain("min-[360px]:grid-cols-2");
    expect(layout).toContain("sm:[&_button]:w-auto");
    expect(layout).toContain("[&_input]:w-full");
    expect(layout).toContain("**:[[role=combobox]]:w-full");
    expect(layout).not.toContain("xs:grid-cols-2");
  });

  it("uses semantic and accessible page navigation", () => {
    const header = source("client/src/components/PageHeader.tsx");

    expect(header).toContain("<header");
    expect(header).toContain('aria-label="Page navigation"');
    expect(header).toContain('aria-label="Previous record"');
    expect(header).toContain('aria-label="Next record"');
    expect(header).toContain("WorkspaceActions");
    // The subtitle must render as a semantic paragraph with muted styling.
    expect(header).toContain('data-testid="text-page-subtitle"');
    expect(header).toMatch(/<p [^>]*text-muted-foreground[^>]*data-testid="text-page-subtitle"/);
  });

  it("supports consistent pending and secondary page-state actions", () => {
    const states = source("client/src/components/ui/page-state.tsx");

    expect(states).toContain("actionPending?: boolean");
    expect(states).toContain("secondaryActionLabel?: string");
    expect(states).toContain("aria-busy={actionPending}");
    expect(states).toContain("motion-reduce:animate-none");
    expect(states).toContain("WorkspaceActions");
  });
});
