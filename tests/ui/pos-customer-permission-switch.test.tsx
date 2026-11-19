import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PosCustomerPermissionSwitch } from "../../client/src/pages/settings/users/PosCustomerPermissionSwitch";

describe("Zambia POS customer permission control", () => {
  it("starts disabled, shows its purpose and sends the new flag to the role editor", () => {
    const onChange = vi.fn();
    render(<PosCustomerPermissionSwitch enabled={false} onChange={onChange} />);
    const toggle = screen.getByTestId("switch-pos-can-access-customers");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/view customer accounts and create new customers/i)).toBeInTheDocument();
  });
});
