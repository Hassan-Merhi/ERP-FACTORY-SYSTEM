// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  REMOTE_CONTROL_ALLOWED_ACTIONS,
  REMOTE_CONTROL_ACTION_SET,
  isRegisteredRemoteControlAction,
  getRemoteControlAction,
} from "./remote-control-action-registry";
import { isAllowedRemoteClickElement } from "./remote-mouse-control-policy";

describe("remote-control-action registry", () => {
  it("contains only expected vetted actions", () => {
    expect(REMOTE_CONTROL_ALLOWED_ACTIONS.length).toBeGreaterThan(10);
    for (const a of REMOTE_CONTROL_ALLOWED_ACTIONS) {
      expect(REMOTE_CONTROL_ACTION_SET.has(a)).toBe(true);
    }
  });

  it("recognizes registered actions", () => {
    expect(isRegisteredRemoteControlAction("view")).toBe(true);
    expect(isRegisteredRemoteControlAction("toggle-view")).toBe(true);
    expect(isRegisteredRemoteControlAction("view-invoice")).toBe(true);
    expect(isRegisteredRemoteControlAction("not-registered")).toBe(false);
    expect(isRegisteredRemoteControlAction("")).toBe(false);
    expect(isRegisteredRemoteControlAction(null)).toBe(false);
  });

  it("reads data-remote-control-action from elements", () => {
    const el = document.createElement("button");
    el.setAttribute("data-remote-control-action", "view");
    expect(getRemoteControlAction(el)).toBe("view");
    el.setAttribute("data-remote-control-action", "  toggle-view  ");
    expect(getRemoteControlAction(el)).toBe("toggle-view");
    el.removeAttribute("data-remote-control-action");
    expect(getRemoteControlAction(el)).toBeNull();
  });

  it("allows clicks only when the registry action is vetted", () => {
    const registered = document.createElement("button");
    registered.textContent = "View";
    registered.setAttribute("data-remote-control-action", "view");
    document.body.appendChild(registered);
    expect(isAllowedRemoteClickElement(registered)).toBe(true);

    const unregistered = document.createElement("button");
    unregistered.textContent = "View";
    unregistered.setAttribute("data-remote-control-action", "delete-everything");
    document.body.appendChild(unregistered);
    expect(isAllowedRemoteClickElement(unregistered)).toBe(false);

    // Unregistered action cannot be rescued by matching safe text
    const heuristicButton = document.createElement("button");
    heuristicButton.textContent = "View details";
    heuristicButton.setAttribute("data-remote-control-action", "not-allowlisted");
    document.body.appendChild(heuristicButton);
    expect(isAllowedRemoteClickElement(heuristicButton)).toBe(false);

    // Without the attribute, the text heuristic still applies (backward compat)
    const legacy = document.createElement("button");
    legacy.textContent = "View details";
    document.body.appendChild(legacy);
    expect(isAllowedRemoteClickElement(legacy)).toBe(true);

    // Registry cannot override dangerous or blocked surfaces
    const dangerous = document.createElement("button");
    dangerous.textContent = "Delete voucher";
    dangerous.setAttribute("data-remote-control-action", "view");
    document.body.appendChild(dangerous);
    expect(isAllowedRemoteClickElement(dangerous)).toBe(false);

    const blockedForm = document.createElement("form");
    const formSafe = document.createElement("button");
    formSafe.textContent = "View details";
    formSafe.setAttribute("data-remote-control-action", "view");
    blockedForm.appendChild(formSafe);
    document.body.appendChild(blockedForm);
    expect(isAllowedRemoteClickElement(formSafe)).toBe(false);

    document.body.innerHTML = "";
  });
});
