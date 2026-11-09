import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErpFormActions, ErpPendingButton } from "./ErpFormActions";

describe("ERP form actions", () => {
  it("keeps ordinary actions non-submitting and disables pending writes", () => {
    const save = vi.fn();
    const { rerender } = render(
      <form>
        <ErpFormActions>
          <ErpPendingButton onClick={save}>Save</ErpPendingButton>
        </ErpFormActions>
      </form>
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();

    rerender(
      <ErpFormActions>
        <ErpPendingButton pending pendingLabel="Saving…" onClick={save}>Save</ErpPendingButton>
      </ErpFormActions>
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps native submit semantics when explicitly requested", () => {
    render(
      <ErpFormActions>
        <ErpPendingButton type="submit">Create</ErpPendingButton>
      </ErpFormActions>
    );
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("type", "submit");
  });
});
