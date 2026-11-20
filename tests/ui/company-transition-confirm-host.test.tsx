import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    children,
    title,
    onConfirm,
  }: {
    children?: ReactNode;
    title: string;
    onConfirm: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      <button onClick={onConfirm}>Confirm</button>
      {children}
    </div>
  ),
}));

import { ConfirmHost, confirmAction, promptText } from "@/components/ConfirmHost";
import { announceCompanyWorkspaceTransition } from "@/lib/companyWorkspaceEvents";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("company transition and app-wide confirmations", () => {
  it("cancels queued confirmations and prompts rather than allowing wrong-company writes", async () => {
    const app = render(<ConfirmHost />);
    let oldConfirmation!: Promise<boolean>;
    let oldPrompt!: Promise<string | null>;

    await act(async () => {
      oldConfirmation = confirmAction({ title: "Company A voucher" });
      oldPrompt = promptText({ title: "Company A reason", label: "Reason" });
    });
    expect(screen.getByRole("dialog", { name: "Company A voucher" })).toBeTruthy();

    await act(async () => {
      announceCompanyWorkspaceTransition();
    });

    await expect(oldConfirmation).resolves.toBe(false);
    await expect(oldPrompt).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    let newConfirmation!: Promise<boolean>;
    await act(async () => {
      newConfirmation = confirmAction({ title: "Company B voucher" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await expect(newConfirmation).resolves.toBe(true);
    app.unmount();
  });
});
