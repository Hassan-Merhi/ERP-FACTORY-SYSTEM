/**
 * The remote keyboard policy decides which fields a support agent may type
 * into and what each remote key does there. These cases cover the rules the
 * unit tests leave out: labels and autocomplete hints that mark a field
 * sensitive, checkbox, select and form opt-ins, field length limits, and
 * every editing key including Tab, Escape, Enter, Space, Backspace, Delete,
 * arrows and number stepping.
 */
import {
  applyRemoteKeyboardCommand,
  clearRemoteEditableFocus,
  focusRemoteEditableElement,
  getRemoteEditableFocus,
  isSafeRemoteEditableElement,
  noteTrustedLocalRemoteControlInteraction,
  type RemoteKeyboardKey,
} from "@/hooks/remote-keyboard-control-policy";

const NOW = 10_000_000;
const key = (k: RemoteKeyboardKey, shiftKey = false) =>
  applyRemoteKeyboardCommand({ id: "c", sessionId: "s", type: "key", sequence: 1, key: k, shiftKey }, document, NOW);
const text = (value: unknown) =>
  applyRemoteKeyboardCommand(
    { id: "c", sessionId: "s", type: "insert-text", sequence: 1, text: value as string, shiftKey: false },
    document,
    NOW
  );

function field<T extends HTMLElement>(html: string): T {
  document.body.innerHTML = html;
  return document.body.querySelector("[data-target]") as T;
}
function focused<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(html: string): T {
  const element = field<T>(html);
  expect(focusRemoteEditableElement(element)).toBe(true);
  return element;
}

afterEach(() => {
  // The local-activity timestamp is module state: put it back in the past.
  noteTrustedLocalRemoteControlInteraction(0);
  clearRemoteEditableFocus();
  document.body.innerHTML = "";
});

describe("which fields are safe", () => {
  it.each([
    ['<label for="f">Password hint</label><input id="f" data-target />', false],
    ['<label for="f">Search stock</label><input id="f" data-target />', true],
    ['<input data-target autocomplete="cc-number" placeholder="Card" />', false],
    ['<input data-target type="hidden" />', false],
    ['<input data-target type="file" />', false],
    ['<input data-target type="color" />', false],
    ['<input data-target type="checkbox" />', false],
    ['<input data-target type="checkbox" data-remote-control-editable="true" />', true],
    ["<select data-target><option>a</option></select>", false],
    ['<select data-target aria-label="Filter status"><option>a</option></select>', true],
    ["<form><input data-target /></form>", false],
    ['<form><input data-target name="search" /></form>', true],
    ['<form><input data-target data-remote-control-editable="true" /></form>', true],
    ['<input data-target placeholder="Customer" />', false],
    ['<input data-target placeholder="Customer name filter" />', true],
    ["<div data-sensitive-action><input data-target /></div>", false],
    ["<input data-target readonly />", false],
    ["<textarea data-target></textarea>", true],
    ["<button data-target>Go</button>", false],
  ])("%s → %s", (html, safe) => {
    expect(isSafeRemoteEditableElement(field(html))).toBe(safe);
  });

  it("forgets a focused field that is unsafe or was removed", () => {
    expect(focusRemoteEditableElement(field('<input data-target type="password" />'))).toBe(false);
    expect(getRemoteEditableFocus()).toBeNull();

    const input = focused<HTMLInputElement>("<input data-target />");
    expect(getRemoteEditableFocus()).toBe(input);
    input.remove();
    expect(getRemoteEditableFocus()).toBeNull();
    expect(key("End")).toEqual({ status: "blocked", reason: "no-safe-editable-focus" });
  });

  it("yields to the local user for a moment after they interact", () => {
    focused("<input data-target />");
    noteTrustedLocalRemoteControlInteraction(NOW - 500);

    expect(key("End")).toEqual({ status: "blocked", reason: "local-user-active" });
    expect(getRemoteEditableFocus()).toBeNull();
  });
});

describe("text", () => {
  it("inserts at the caret and fires input and change", () => {
    const input = focused<HTMLInputElement>('<input data-target value="ac" />');
    input.setSelectionRange(1, 1);
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    expect(text("b")).toEqual({ status: "executed", reason: null });
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(2);
    expect(events).toEqual(["input", "change"]);
  });

  it("rejects empty or control text, text for selects and checkboxes, and text past the field limit", () => {
    focused("<input data-target />");
    expect(text("")).toEqual({ status: "ignored", reason: "invalid-text" });
    expect(text("a\u0007")).toEqual({ status: "ignored", reason: "invalid-text" });
    expect(text(5)).toEqual({ status: "ignored", reason: "invalid-text" });

    focused('<select data-target aria-label="filter"><option>a</option></select>');
    expect(text("a")).toEqual({ status: "blocked", reason: "text-not-supported" });

    focused('<input data-target type="checkbox" data-remote-control-editable="true" />');
    expect(text("a")).toEqual({ status: "blocked", reason: "text-not-supported" });

    const limited = focused<HTMLInputElement>('<input data-target maxlength="2" value="ab" />');
    expect(text("c")).toEqual({ status: "blocked", reason: "field-length-limit" });
    expect(limited.value).toBe("ab");
    expect(key("Space")).toEqual({ status: "blocked", reason: "field-length-limit" });
  });
});

describe("keys", () => {
  it("Escape leaves the field, Tab moves between safe fields both ways", () => {
    document.body.innerHTML = `<input id="a" /><input id="b" type="password" /><input id="c" /><input id="d" />`;
    const [a, , c, d] = Array.from(document.querySelectorAll("input"));
    focusRemoteEditableElement(a);

    expect(key("Tab")).toEqual({ status: "executed", reason: null });
    expect(getRemoteEditableFocus()).toBe(c);
    key("Tab");
    expect(getRemoteEditableFocus()).toBe(d);
    key("Tab");
    expect(getRemoteEditableFocus()).toBe(a);
    key("Tab", true);
    expect(getRemoteEditableFocus()).toBe(d);
    key("Tab", true);
    expect(getRemoteEditableFocus()).toBe(c);

    expect(key("Escape")).toEqual({ status: "executed", reason: null });
    expect(getRemoteEditableFocus()).toBeNull();
  });

  it("dispatches the key to the page before applying it", () => {
    const input = focused<HTMLInputElement>("<input data-target />");
    const seen: string[] = [];
    input.addEventListener("keydown", (event) => seen.push(event.key));

    key("Space");

    expect(seen).toEqual([" "]);
  });

  it("moves through enabled select options with arrows, Home and End only", () => {
    const select = focused<HTMLSelectElement>(
      `<select data-target aria-label="Filter"><option value="a">A</option><option value="b" disabled>B</option><option value="c">C</option><option value="d">D</option></select>`
    );

    key("ArrowDown");
    expect(select.value).toBe("c");
    key("End");
    expect(select.value).toBe("d");
    key("ArrowDown");
    expect(select.value).toBe("d");
    key("ArrowUp");
    expect(select.value).toBe("c");
    key("Home");
    expect(select.value).toBe("a");
    key("ArrowUp");
    expect(select.value).toBe("a");
    expect(key("Enter")).toEqual({ status: "blocked", reason: "select-key-blocked" });

    focused(`<select data-target aria-label="Filter"><option disabled>x</option></select>`);
    expect(key("ArrowDown")).toEqual({ status: "blocked", reason: "select-key-blocked" });
  });

  it("toggles an opted-in checkbox and selects a radio with Space, and blocks other keys", () => {
    const box = focused<HTMLInputElement>('<input data-target type="checkbox" data-remote-control-editable="true" />');
    expect(key("Space")).toEqual({ status: "executed", reason: null });
    expect(box.checked).toBe(true);
    key("Space");
    expect(box.checked).toBe(false);
    expect(key("Enter")).toEqual({ status: "blocked", reason: "checkbox-key-blocked" });

    const radio = focused<HTMLInputElement>('<input data-target type="radio" data-remote-control-editable="true" />');
    key("Space");
    key("Space");
    expect(radio.checked).toBe(true);
  });

  it("Enter breaks a line in a textarea and completes only filters or opted-in fields", () => {
    const area = focused<HTMLTextAreaElement>("<textarea data-target>ab</textarea>");
    area.setSelectionRange(1, 1);
    expect(key("Enter")).toEqual({ status: "executed", reason: null });
    expect(area.value).toBe("a\nb");

    focused<HTMLTextAreaElement>('<textarea data-target maxlength="2">ab</textarea>');
    expect(key("Enter")).toEqual({ status: "blocked", reason: "field-length-limit" });

    focused('<input data-target placeholder="Search" />');
    expect(key("Enter")).toEqual({ status: "executed", reason: null });
    focused('<input data-target data-remote-control-editable="true" />');
    expect(key("Enter")).toEqual({ status: "executed", reason: null });
    focused("<input data-target />");
    expect(key("Enter")).toEqual({ status: "blocked", reason: "form-submit-blocked" });
  });

  it("Backspace and Delete remove the selection or one character beside the caret", () => {
    const input = focused<HTMLInputElement>('<input data-target value="abcd" />');

    input.setSelectionRange(1, 3);
    expect(key("Delete")).toEqual({ status: "executed", reason: null });
    expect(input.value).toBe("ad");

    input.setSelectionRange(1, 1);
    key("Backspace");
    expect(input.value).toBe("d");

    input.setSelectionRange(0, 0);
    expect(key("Backspace")).toEqual({ status: "ignored", reason: "nothing-to-delete" });
    key("Delete");
    expect(input.value).toBe("");
    expect(key("Delete")).toEqual({ status: "ignored", reason: "nothing-to-delete" });

    input.value = "xy";
    input.setSelectionRange(0, 2);
    key("Backspace");
    expect(input.value).toBe("");
  });

  it("moves the caret with arrows, Home and End", () => {
    const input = focused<HTMLInputElement>('<input data-target value="abcd" />');
    input.setSelectionRange(2, 2);

    key("ArrowLeft");
    expect(input.selectionStart).toBe(1);
    key("ArrowRight");
    expect(input.selectionStart).toBe(2);
    key("End");
    expect(input.selectionStart).toBe(4);
    key("ArrowRight");
    expect(input.selectionStart).toBe(4);
    key("Home");
    expect(input.selectionStart).toBe(0);
    key("ArrowLeft");
    expect(input.selectionStart).toBe(0);
    expect(key("ArrowUp")).toEqual({ status: "ignored", reason: "vertical-key-not-supported" });
  });

  it("steps opted-in number fields, and refuses caret moves where selection is unsupported", () => {
    const number = focused<HTMLInputElement>(
      '<input data-target type="number" value="2" data-remote-control-editable="true" />'
    );
    expect(key("ArrowUp")).toEqual({ status: "executed", reason: null });
    expect(number.value).toBe("3");
    key("ArrowDown");
    key("ArrowDown");
    expect(number.value).toBe("1");

    focused('<input data-target type="number" value="2" placeholder="Item code" />');
    expect(key("ArrowUp")).toEqual({ status: "ignored", reason: "vertical-key-not-supported" });
    expect(key("Home")).toEqual({ status: "blocked", reason: "selection-not-supported" });
  });

  it("ignores a key command without a key", () => {
    focused("<input data-target />");
    expect(
      applyRemoteKeyboardCommand({ id: "c", sessionId: "s", type: "key", sequence: 1, shiftKey: false }, document, NOW)
    ).toEqual({ status: "ignored", reason: "invalid-key" });
  });
});
