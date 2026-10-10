import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 4 forms and dialogs", () => {
  it("keeps base and workflow dialogs inside the visual viewport", () => {
    const dialog = source("client/src/components/ui/dialog.tsx");
    const workflowDialog = source("client/src/components/ui/workflow-dialog.tsx");

    expect(dialog).toContain("DialogBody");
    expect(dialog).toContain("data-dialog-body");
    expect(dialog).toContain("max-h-[calc(var(--app-viewport-height)-1rem)]");
    expect(dialog).toContain("overflow-y-auto overscroll-contain");
    expect(dialog).toContain("*:min-h-11");
    expect(workflowDialog).toContain("<DialogBody");
    expect(workflowDialog).toContain("var(--app-viewport-height)");
  });

  it("makes confirmation dialogs and sheets phone safe", () => {
    const alertDialog = source("client/src/components/ui/alert-dialog.tsx");
    const sheet = source("client/src/components/ui/sheet.tsx");

    expect(alertDialog).toContain("w-[calc(100vw-1rem)]");
    expect(alertDialog).toContain("var(--app-viewport-height)");
    expect(alertDialog).toContain("*:min-h-11");
    expect(alertDialog).toContain("motion-reduce:animate-none");

    expect(sheet).toContain("h-(--app-viewport-height)");
    expect(sheet).toContain("w-[calc(100vw-0.75rem)]");
    expect(sheet).toContain('aria-label="Close panel"');
    expect(sheet).toContain("min-h-11 min-w-11");
    expect(sheet).toContain("*:min-h-11");
    expect(sheet).toContain('data-slot="sheet-content"');
  });

  it("provides responsive form layouts and touch-sized select controls", () => {
    const form = source("client/src/components/ui/form.tsx");
    const select = source("client/src/components/ui/select.tsx");

    expect(form).toContain("FormGrid");
    expect(form).toContain("repeat(auto-fit, minmax(min(100%");
    expect(form).toContain("FormSection");
    expect(form).toContain("FormSectionLegend");
    expect(form).toContain("scroll-mt-24");
    expect(form).toContain("aria-errormessage");
    expect(form).toContain("wrap-break-word");

    expect(select).toContain("h-11");
    expect(select).toContain("sm:h-9");
    expect(select).toContain("max-w-[calc(100vw-1rem)]");
    expect(select).toContain("min-h-11");
    expect(select).toContain("overscroll-contain");
  });

  it("keeps shared primitives free from business behavior", () => {
    const sharedSources = [
      "client/src/components/ui/dialog.tsx",
      "client/src/components/ui/alert-dialog.tsx",
      "client/src/components/ui/sheet.tsx",
      "client/src/components/ui/form.tsx",
      "client/src/components/ui/select.tsx",
      "client/src/components/ui/workflow-dialog.tsx",
    ].map(source);

    for (const contents of sharedSources) {
      for (const forbidden of ["/api/", "useMutation(", "useQuery(", "queryClient", "ledgerAccount", "costPerKg"]) {
        expect(contents).not.toContain(forbidden);
      }
    }
  });
});
