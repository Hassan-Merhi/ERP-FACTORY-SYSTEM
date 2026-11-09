import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Input } from "@/components/ui/input";
import { ErpField } from "./ErpField";

describe("ERP fields", () => {
  it("associates label, description and validation error with the owned input", () => {
    const onChange = vi.fn();
    render(
      <ErpField id="vendor-name" label="Vendor name" description="Legal name" error="Name is required" required>
        {(control) => <Input {...control} value="" onChange={onChange} />}
      </ErpField>
    );

    const input = screen.getByRole("textbox", { name: /Vendor name/ });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAttribute("aria-describedby", "vendor-name-description vendor-name-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Name is required");
    fireEvent.change(input, { target: { value: "ACME" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("renders a valid field without an error announcement", () => {
    render(
      <ErpField label="Notes">
        {(control) => <Input {...control} defaultValue="Hello" />}
      </ErpField>
    );
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Hello");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
