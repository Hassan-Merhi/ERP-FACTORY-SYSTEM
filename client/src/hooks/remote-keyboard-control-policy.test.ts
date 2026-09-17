// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemoteKeyboardCommand,
  clearRemoteEditableFocus,
  focusRemoteEditableElement,
  isSafeRemoteEditableElement,
  noteTrustedLocalRemoteControlInteraction,
  type RemoteKeyboardCommandView,
} from "./remote-keyboard-control-policy";

function command(overrides: Partial<RemoteKeyboardCommandView> = {}): RemoteKeyboardCommandView {
  return {
    id: "command-1",
    sessionId: "session-1",
    type: "insert-text",
    sequence: 1,
    text: "A",
    shiftKey: false,
    ...overrides,
  };
}

function appendInput(attributes: Record<string, string> = {}): HTMLInputElement {
  const input = document.createElement("input");
  for (const [key, value] of Object.entries(attributes)) input.setAttribute(key, value);
  document.body.appendChild(input);
  return input;
}

describe("remote keyboard editing policy", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearRemoteEditableFocus();
    noteTrustedLocalRemoteControlInteraction(0);
  });

  it("allows search/entity filters while blocking credential and financial fields", () => {
    const search = appendInput({ type: "search", placeholder: "Search by name" });
    const customer = appendInput({ type: "text", placeholder: "Customer name" });
    const supplier = appendInput({ type: "text", "aria-label": "Supplier code" });
    const item = appendInput({ type: "text", placeholder: "Item description" });
    const password = appendInput({ type: "password", autocomplete: "current-password" });
    const amount = appendInput({ type: "number", name: "paymentAmount" });
    const protectedInput = appendInput({ type: "text", placeholder: "Search" });
    protectedInput.dataset.remoteControlBlocked = "true";

    expect(isSafeRemoteEditableElement(search)).toBe(true);
    expect(isSafeRemoteEditableElement(customer)).toBe(true);
    expect(isSafeRemoteEditableElement(supplier)).toBe(true);
    expect(isSafeRemoteEditableElement(item)).toBe(true);
    expect(isSafeRemoteEditableElement(password)).toBe(false);
    expect(isSafeRemoteEditableElement(amount)).toBe(false);
    expect(isSafeRemoteEditableElement(protectedInput)).toBe(false);
  });

  it("allows explicitly approved non-sensitive form fields", () => {
    const form = document.createElement("form");
    const note = document.createElement("textarea");
    note.name = "internalNote";
    note.dataset.remoteControlEditable = "true";
    form.appendChild(note);
    document.body.appendChild(form);

    expect(isSafeRemoteEditableElement(note)).toBe(true);
    expect(focusRemoteEditableElement(note)).toBe(true);
  });

  it("inserts text through native value and React-compatible input/change events", () => {
    const input = appendInput({ type: "search", placeholder: "Search" });
    input.value = "ab";
    input.setSelectionRange(1, 1);
    const inputListener = vi.fn();
    const changeListener = vi.fn();
    input.addEventListener("input", inputListener);
    input.addEventListener("change", changeListener);
    focusRemoteEditableElement(input);

    expect(applyRemoteKeyboardCommand(command({ text: "Z" }), document, 5000)).toEqual({
      status: "executed",
      reason: null,
    });
    expect(input.value).toBe("aZb");
    expect(input.selectionStart).toBe(2);
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledTimes(1);
  });

  it("supports deletion, caret movement, and Enter on safe search/filter controls", () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search customer name";
    input.value = "abcd";
    form.appendChild(input);
    document.body.appendChild(form);
    input.setSelectionRange(2, 2);
    focusRemoteEditableElement(input);

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Backspace", text: undefined }), document, 5000)
    ).toMatchObject({ status: "executed" });
    expect(input.value).toBe("acd");

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "End", text: undefined }), document, 5001)
    ).toMatchObject({ status: "executed" });
    expect(input.selectionStart).toBe(input.value.length);

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Enter", text: undefined }), document, 5002)
    ).toEqual({ status: "executed", reason: null });
  });

  it("still blocks Enter for an explicitly editable non-filter write field", () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.name = "internalMemo";
    input.dataset.remoteControlEditable = "true";
    form.appendChild(input);
    document.body.appendChild(form);
    focusRemoteEditableElement(input);

    // Explicit editability permits text editing, but Enter never synthesizes a
    // native form submission. The command is treated as handled locally.
    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Enter", text: undefined }), document, 5000)
    ).toEqual({ status: "executed", reason: null });
  });

  it("supports textarea line breaks and safe Tab navigation", () => {
    const first = document.createElement("textarea");
    first.placeholder = "Notes";
    first.dataset.remoteControlEditable = "true";
    const second = appendInput({ type: "search", placeholder: "Search" });
    document.body.prepend(first);
    focusRemoteEditableElement(first);

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Enter", text: undefined }), document, 5000)
    ).toMatchObject({ status: "executed" });
    expect(first.value).toBe("\n");

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Tab", text: undefined }), document, 5001)
    ).toMatchObject({ status: "executed" });
    expect(document.activeElement).toBe(second);
  });

  it("changes safe select and explicitly approved checkbox controls", () => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Filter status");
    select.innerHTML = '<option value="a">A</option><option value="b">B</option>';
    document.body.appendChild(select);
    focusRemoteEditableElement(select);

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "ArrowDown", text: undefined }), document, 5000)
    ).toMatchObject({ status: "executed" });
    expect(select.value).toBe("b");

    const checkbox = appendInput({ type: "checkbox", "data-remote-control-editable": "true" });
    focusRemoteEditableElement(checkbox);
    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Space", text: undefined }), document, 5001)
    ).toMatchObject({ status: "executed" });
    expect(checkbox.checked).toBe(true);
  });

  it("blocks remote typing while the local employee is interacting", () => {
    const input = appendInput({ type: "search", placeholder: "Search" });
    focusRemoteEditableElement(input);
    noteTrustedLocalRemoteControlInteraction(5000);

    expect(applyRemoteKeyboardCommand(command(), document, 5500)).toEqual({
      status: "blocked",
      reason: "local-user-active",
    });
    expect(input.value).toBe("");
  });

  it("fails closed without a safe remote focus or for invalid text", () => {
    expect(applyRemoteKeyboardCommand(command(), document, 5000)).toEqual({
      status: "blocked",
      reason: "no-safe-editable-focus",
    });

    const input = appendInput({ type: "search", placeholder: "Search" });
    focusRemoteEditableElement(input);
    expect(applyRemoteKeyboardCommand(command({ text: "bad\ntext" }), document, 5000)).toEqual({
      status: "ignored",
      reason: "invalid-text",
    });
  });

  it("enforces maxLength and Escape clears remote focus", () => {
    const input = appendInput({ type: "search", placeholder: "Search", maxlength: "2" });
    input.value = "ab";
    focusRemoteEditableElement(input);
    expect(applyRemoteKeyboardCommand(command({ text: "c" }), document, 5000)).toEqual({
      status: "blocked",
      reason: "field-length-limit",
    });

    expect(
      applyRemoteKeyboardCommand(command({ type: "key", key: "Escape", text: undefined }), document, 5001)
    ).toMatchObject({ status: "executed" });
    expect(document.activeElement).not.toBe(input);
  });
});
