import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormGrid, FormSection, FormSectionLegend } from "@/components/ui/form";
import { PhoneSheetDialogs } from "@/components/ui/phone-sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { WorkflowDialog } from "@/components/ui/workflow-dialog";

/**
 * Phase 4 contract for forms and dialogs, checked on rendered output. `useErpPhoneLayout` falls
 * back to `window.innerWidth` when `matchMedia` is missing (jsdom), so a phone is simulated by
 * narrowing the window.
 */
const DESKTOP_WIDTH = 1280;
const PHONE_WIDTH = 390;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  setViewportWidth(DESKTOP_WIDTH);
});

afterEach(() => {
  cleanup();
  setViewportWidth(DESKTOP_WIDTH);
});

function SampleDialog({ contentClassName, actions = 2 }: { contentClassName?: string; actions?: number }) {
  return (
    <Dialog open>
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>Change the details below.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p>form</p>
        </DialogBody>
        <DialogFooter data-testid="footer">
          <button type="button">Cancel</button>
          {actions >= 2 && <button type="submit">Save</button>}
          {actions >= 3 && <button type="button">Delete</button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const dialog = () => screen.getByRole("dialog");
const header = () => screen.getByText("Edit customer").parentElement as HTMLElement;
const closeButton = () => screen.getByRole("button", { name: "Close dialog" });

describe("Mobile responsiveness Phase 4 forms and dialogs", () => {
  it("centres dialogs inside the visual viewport on desktop and outside the phone-sheet shells", () => {
    setViewportWidth(PHONE_WIDTH);
    render(<SampleDialog contentClassName="max-w-2xl" />);

    expect(dialog()).not.toHaveAttribute("data-phone-sheet");
    expect(dialog().className).toContain("-translate-x-1/2");
    expect(dialog().className).toContain("max-h-[calc(var(--app-viewport-height)-1rem)]");
    expect(dialog().className).toContain("overflow-y-auto");
    expect(dialog().className).toContain("max-w-2xl");
    expect(screen.getByText("form").parentElement).toHaveAttribute("data-dialog-body", "true");
    expect(screen.getByTestId("footer").className).toContain("[&>*]:min-h-11");
    expect(header().className).not.toContain("sticky");
  });

  it("opens dialogs as bottom sheets on phones inside a phone-sheet shell", () => {
    setViewportWidth(PHONE_WIDTH);
    render(
      <PhoneSheetDialogs>
        <SampleDialog contentClassName="max-w-2xl max-h-[90vh] w-[95vw]" />
      </PhoneSheetDialogs>
    );

    const content = dialog();
    expect(content).toHaveAttribute("data-phone-sheet", "true");
    // Anchored to the bottom edge above the keyboard, full width, rounded on top.
    expect(content.className).toContain("inset-x-0");
    expect(content.className).toContain("bottom-[var(--erp-keyboard-inset,0px)]");
    expect(content.className).toContain("rounded-t-2xl");
    expect(content.className).toContain("slide-in-from-bottom");
    // Sized to what the user can see, whatever the caller asked for on desktop.
    expect(content.className).toContain("max-w-full");
    expect(content.className).toContain("var(--erp-visual-viewport-height");
    for (const callerClass of ["max-w-2xl", "max-h-[90vh]", "w-[95vw]", "-translate-x-1/2", "zoom-in-95"]) {
      expect(content.className).not.toContain(callerClass);
    }
    // Title and close control stay in view; the two actions share one pinned row.
    expect(header().className).toContain("sticky");
    expect(closeButton().className).toContain("sticky");
    expect(closeButton().className).toContain("order-first");
    expect(screen.getByTestId("footer").className).toContain("sticky");
    expect(screen.getByTestId("footer").className).toContain("grid-cols-2");
  });

  it("keeps a three-action footer stacked and leaves self-framed dialogs alone", () => {
    setViewportWidth(PHONE_WIDTH);
    render(
      <PhoneSheetDialogs>
        <SampleDialog contentClassName="p-0" actions={3} />
      </PhoneSheetDialogs>
    );

    expect(dialog()).toHaveAttribute("data-phone-sheet", "true");
    expect(screen.getByTestId("footer").className).not.toContain("grid-cols-2");
    expect(screen.getByTestId("footer").className).toContain("sticky");
    // A `p-0` frame lays out its own header, so the header is not made sticky for it.
    expect(header().className).not.toContain("sticky");
  });

  it("keeps the centred modal on tablets and desktops inside a phone-sheet shell", () => {
    render(
      <PhoneSheetDialogs>
        <SampleDialog />
      </PhoneSheetDialogs>
    );

    expect(dialog()).not.toHaveAttribute("data-phone-sheet");
    expect(dialog().className).toContain("-translate-x-1/2");
    expect(dialog().className).toContain("zoom-in-95");
    expect(screen.getByTestId("footer").className).not.toContain("sticky");
  });

  it("renders workflow dialogs with a scrolling body", () => {
    render(
      <WorkflowDialog open onOpenChange={() => {}} title="Post voucher" description="Review before posting">
        <p>body</p>
      </WorkflowDialog>
    );

    expect(screen.getByText("body").closest("[data-dialog-body]")).not.toBeNull();
    expect(screen.getByRole("dialog").className).toContain("var(--app-viewport-height)");
  });

  it("makes confirmation dialogs phone safe", () => {
    setViewportWidth(PHONE_WIDTH);
    render(
      <PhoneSheetDialogs>
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>Delete voucher?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            <AlertDialogFooter data-testid="alert-footer">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PhoneSheetDialogs>
    );

    const content = screen.getByRole("alertdialog");
    expect(content).toHaveAttribute("data-phone-sheet", "true");
    expect(content.className).toContain("inset-x-0");
    expect(content.className).toContain("motion-reduce:animate-none");
    expect(screen.getByTestId("alert-footer").className).toContain("grid-cols-2");
    expect(screen.getByTestId("alert-footer").className).toContain("[&>*]:min-h-11");
  });

  it("gives sheets a full-height panel, a touch-sized close control, and a keyboard-aware bottom edge", () => {
    render(
      <Sheet open>
        <SheetContent side="bottom" data-testid="sheet">
          <SheetTitle>Filters</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    const sheet = screen.getByTestId("sheet");
    expect(sheet).toHaveAttribute("data-slot", "sheet-content");
    expect(sheet).toHaveAttribute("data-sheet-side", "bottom");
    expect(sheet.className).toContain("bottom-[var(--erp-keyboard-inset,0px)]");
    expect(sheet.className).toContain("overflow-y-auto");
    const close = screen.getByRole("button", { name: "Close panel" });
    expect(close.className).toMatch(/\bmin-h-11\b/);
    expect(close.className).toMatch(/\bmin-w-11\b/);
  });

  it("lets the phone sheet own the scrolling of a table inside it", () => {
    setViewportWidth(PHONE_WIDTH);
    render(
      <PhoneSheetDialogs>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Pick an entry</DialogTitle>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell>row</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </DialogContent>
        </Dialog>
      </PhoneSheetDialogs>
    );

    const region = screen.getByRole("region", { name: "Scrollable data table" });
    expect(region).toHaveAttribute("data-scroll-mode", "parent");
    expect(region.className).not.toContain("max-h-[70vh]");
  });

  it("provides responsive form layouts and touch-sized select controls", () => {
    render(
      <>
        <FormGrid data-testid="grid" minColumnWidth="12rem">
          <input aria-label="A" />
        </FormGrid>
        <FormSection data-testid="section">
          <FormSectionLegend>Address</FormSectionLegend>
        </FormSection>
        <Select>
          <SelectTrigger aria-label="Currency">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="usd">USD</SelectItem>
          </SelectContent>
        </Select>
      </>
    );

    // Columns never drop below the phone width: each column is at most 100% wide.
    expect(screen.getByTestId("grid").style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))"
    );
    expect(screen.getByTestId("section").tagName).toBe("FIELDSET");
    expect(screen.getByText("Address").tagName).toBe("LEGEND");
    const trigger = screen.getByRole("combobox", { name: "Currency" });
    expect(trigger.className).toMatch(/\bh-11\b/);
    expect(trigger.className).toMatch(/\bsm:h-9\b/);
  });

  it("keeps shared primitives free from business behavior", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setViewportWidth(PHONE_WIDTH);
    render(
      <PhoneSheetDialogs>
        <SampleDialog />
      </PhoneSheetDialogs>
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
