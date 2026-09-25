import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Guards the window-blur shim in tests/ui/setup.ts: it must only absorb the
// in-document blur jsdom's focus fixup dispatches at `window`, never a real one.
function renderMenu() {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="menu-trigger">Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const trigger = screen.getByTestId("menu-trigger");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return trigger;
}

describe("jsdom focus fixup vs. Radix menus", () => {
  it("opens a menu after the previously focused element was removed", () => {
    const stale = document.createElement("button");
    document.body.appendChild(stale);
    stale.focus();
    stale.remove();

    const trigger = renderMenu();

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "First" })).toBeInTheDocument();
  });

  it("still closes an open menu when the window itself loses focus", () => {
    const trigger = renderMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    act(() => {
      window.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
