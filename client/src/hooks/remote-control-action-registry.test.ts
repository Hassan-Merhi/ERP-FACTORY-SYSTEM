// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  REMOTE_CONTROL_ALLOWED_ACTIONS,
  REMOTE_CONTROL_ACTION_SET,
  isRegisteredRemoteControlAction,
  getRemoteControlAction,
} from "./remote-control-action-registry";
import { isAllowedRemoteClickElement, isRemoteMouseBlockedElement } from "./remote-mouse-control-policy";

describe("remote-control-action registry", () => {
  it("contains the exact actively covered vetted actions", () => {
    expect([...REMOTE_CONTROL_ALLOWED_ACTIONS].sort()).toEqual(
      [
        "navigation",
        "toggle-view",
        "view",
        "view-container",
        "view-details",
        "view-invoice",
        "view-profitability",
      ].sort()
    );
    for (const action of REMOTE_CONTROL_ALLOWED_ACTIONS) {
      expect(REMOTE_CONTROL_ACTION_SET.has(action)).toBe(true);
    }
  });

  it("recognizes registered actions", () => {
    expect(isRegisteredRemoteControlAction("view")).toBe(true);
    expect(isRegisteredRemoteControlAction("toggle-view")).toBe(true);
    expect(isRegisteredRemoteControlAction("view-invoice")).toBe(true);
    expect(isRegisteredRemoteControlAction("navigation")).toBe(true);
    expect(isRegisteredRemoteControlAction("not-registered")).toBe(false);
    expect(isRegisteredRemoteControlAction("")).toBe(false);
    expect(isRegisteredRemoteControlAction(null)).toBe(false);
  });

  it("reads data-remote-control-action from elements", () => {
    const element = document.createElement("button");
    element.setAttribute("data-remote-control-action", "view");
    expect(getRemoteControlAction(element)).toBe("view");
    element.setAttribute("data-remote-control-action", "  toggle-view  ");
    expect(getRemoteControlAction(element)).toBe("toggle-view");
    element.removeAttribute("data-remote-control-action");
    expect(getRemoteControlAction(element)).toBeNull();
  });

  it("allows vetted registry actions and rejects unknown or dangerous actions", () => {
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

    const heuristicButton = document.createElement("button");
    heuristicButton.textContent = "View details";
    heuristicButton.setAttribute("data-remote-control-action", "not-allowlisted");
    document.body.appendChild(heuristicButton);
    expect(isAllowedRemoteClickElement(heuristicButton)).toBe(false);

    const legacy = document.createElement("button");
    legacy.textContent = "View details";
    document.body.appendChild(legacy);
    expect(isAllowedRemoteClickElement(legacy)).toBe(true);

    const dangerous = document.createElement("button");
    dangerous.textContent = "Delete voucher";
    dangerous.setAttribute("data-remote-control-action", "view");
    document.body.appendChild(dangerous);
    expect(isAllowedRemoteClickElement(dangerous)).toBe(false);
  });

  it("allows an explicitly vetted form control while unannotated and destructive form actions stay blocked", () => {
    const form = document.createElement("form");

    const safe = document.createElement("button");
    safe.type = "button";
    safe.textContent = "View details";
    safe.setAttribute("data-remote-control-action", "view");
    form.appendChild(safe);

    const unannotated = document.createElement("button");
    unannotated.type = "button";
    unannotated.textContent = "View details";
    form.appendChild(unannotated);

    const destructive = document.createElement("button");
    destructive.type = "button";
    destructive.textContent = "Delete voucher";
    destructive.setAttribute("data-remote-control-action", "view");
    form.appendChild(destructive);
    document.body.appendChild(form);

    expect(isRemoteMouseBlockedElement(safe)).toBe(false);
    expect(isAllowedRemoteClickElement(safe)).toBe(true);
    expect(isRemoteMouseBlockedElement(unannotated)).toBe(true);
    expect(isAllowedRemoteClickElement(unannotated)).toBe(false);
    expect(isRemoteMouseBlockedElement(destructive)).toBe(true);
    expect(isAllowedRemoteClickElement(destructive)).toBe(false);

    document.body.innerHTML = "";
  });
});
