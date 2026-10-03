/**
 * ConfirmHost replaces the browser's blocking window.confirm/prompt with the
 * app's own dialog (client/src/components/ConfirmHost.tsx).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmHost, confirmAction, promptText } from "@/components/ConfirmHost";

afterEach(() => cleanup());

function confirmButton() {
  return screen.getByRole("button", { name: "Confirm" });
}

describe("ConfirmHost", () => {
  it("resolves true on confirm and false on cancel", async () => {
    render(<ConfirmHost />);

    let first!: Promise<boolean>;
    act(() => {
      first = confirmAction({ title: "Delete this link?", tone: "destructive" });
    });
    expect(await screen.findByText("Delete this link?")).toBeTruthy();
    fireEvent.click(confirmButton());
    await expect(first).resolves.toBe(true);

    let second!: Promise<boolean>;
    act(() => {
      second = confirmAction({ title: "Delete this group?" });
    });
    expect(await screen.findByText("Delete this group?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(second).resolves.toBe(false);
  });

  it("shows queued requests one at a time, and confirming one does not dismiss the next", async () => {
    render(<ConfirmHost />);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmAction({ title: "First request" });
      second = confirmAction({ title: "Second request" });
    });
    expect(await screen.findByText("First request")).toBeTruthy();
    expect(screen.queryByText("Second request")).toBeNull();

    fireEvent.click(confirmButton());
    await expect(first).resolves.toBe(true);
    expect(await screen.findByText("Second request")).toBeTruthy();

    fireEvent.click(confirmButton());
    await expect(second).resolves.toBe(true);
  });

  it("keeps confirm disabled until the required phrase is typed", async () => {
    render(<ConfirmHost />);

    let result!: Promise<boolean>;
    act(() => {
      result = confirmAction({ title: "Change setup", requirePhrase: "CHANGE SP SETUP" });
    });
    await screen.findByText("Change setup");
    expect(confirmButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "CHANGE SP SETUP" } });
    await waitFor(() => expect(confirmButton().hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirmButton());
    await expect(result).resolves.toBe(true);
  });

  it("returns the trimmed answer from promptText once it meets the minimum length", async () => {
    render(<ConfirmHost />);

    let answer!: Promise<string | null>;
    act(() => {
      answer = promptText({ title: "Reason", label: "Why?", minLength: 5 });
    });
    const input = await screen.findByTestId("input-prompt-text");
    fireEvent.change(input, { target: { value: "  abc " } });
    expect(confirmButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "  wrong rate entered  " } });
    await waitFor(() => expect(confirmButton().hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirmButton());
    await expect(answer).resolves.toBe("wrong rate entered");
  });

  it("treats a request with no mounted host as cancelled", async () => {
    await expect(confirmAction({ title: "Nobody is listening" })).resolves.toBe(false);
    await expect(promptText({ title: "Nobody", label: "x" })).resolves.toBeNull();
  });
});
