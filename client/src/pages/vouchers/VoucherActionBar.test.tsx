import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoucherActionBar, VoucherOptionalSwitch } from "./VoucherActionBar";

let phone = false;
const back = vi.fn();
vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => phone }));
vi.mock("@/hooks/use-back-to-parent", () => ({ useBackToParent: () => back }));

afterEach(() => {
  cleanup();
  phone = false;
  back.mockReset();
});

const ctrlEnter = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter", ctrlKey: true });

describe("VoucherActionBar", () => {
  it("labels a new voucher Save Voucher, shows the shortcut hint and has no Cancel", () => {
    render(<VoucherActionBar isEditing={false} onSave={vi.fn()} summary="2 lines" />);
    const save = screen.getByRole("button", { name: "Save Voucher" });
    expect(save).toHaveAttribute("title", expect.stringMatching(/Enter/));
    expect(save).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByText("2 lines")).toBeInTheDocument();
  });

  it("labels an edit Update Voucher and Cancel goes back to where the voucher was opened", () => {
    render(<VoucherActionBar isEditing onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Update Voucher" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("shows the pending label while saving", () => {
    render(<VoucherActionBar isEditing saving onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("saves on Ctrl+Enter by submitting the enclosing form, from inside a field", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="Amount" onKeyDown={(event) => event.key === "Enter" && event.preventDefault()} />
        <VoucherActionBar isEditing={false} />
      </form>
    );
    screen.getByLabelText("Amount").focus();
    ctrlEnter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not save on Ctrl+Enter while Save is disabled", () => {
    const onSave = vi.fn();
    render(<VoucherActionBar isEditing={false} disabled onSave={onSave} />);
    ctrlEnter();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels an edit on Esc", () => {
    const onCancel = vi.fn();
    render(<VoucherActionBar isEditing onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the same labels and the Ctrl+Enter shortcut on phones", () => {
    phone = true;
    const onSave = vi.fn();
    render(
      <VoucherActionBar
        isEditing
        onSave={onSave}
        optional={<VoucherOptionalSwitch checked={false} onCheckedChange={vi.fn()} />}
      />
    );
    expect(screen.getByRole("button", { name: "Update Voucher" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByLabelText("Optional")).toBeInTheDocument();
    ctrlEnter();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
