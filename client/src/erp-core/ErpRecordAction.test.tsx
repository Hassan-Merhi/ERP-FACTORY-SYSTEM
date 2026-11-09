import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErpRecordAction } from "./ErpRecordAction";

describe("ERP record action", () => {
  it("does not submit a surrounding form or invoke denied operations", () => {
    const onClick = vi.fn();
    render(
      <form>
        <ErpRecordAction permitted={false} deniedReason="View only" onClick={onClick}>Edit</ErpRecordAction>
      </form>
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toHaveAttribute("type", "button");
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", "View only");
    fireEvent.click(edit);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("preserves the caller's click handler when permitted", () => {
    const onClick = vi.fn();
    render(<ErpRecordAction onClick={onClick}>View</ErpRecordAction>);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
