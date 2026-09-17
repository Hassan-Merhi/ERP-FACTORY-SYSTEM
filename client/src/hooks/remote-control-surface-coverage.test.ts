// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateRemoteControlSurface,
  installRemoteControlSurfaceCoverage,
  shouldAnnotateRemoteEditable,
} from "./remote-control-surface-coverage";

describe("remote control surface coverage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/dashboard");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("annotates safe entity filters but not sensitive financial or credential fields", () => {
    const customer = document.createElement("input");
    customer.placeholder = "Customer name";
    const supplier = document.createElement("input");
    supplier.placeholder = "Supplier code";
    const item = document.createElement("input");
    item.placeholder = "Item description";
    const amount = document.createElement("input");
    amount.placeholder = "Search payment amount";
    const password = document.createElement("input");
    password.type = "password";
    password.placeholder = "Search password";
    document.body.append(customer, supplier, item, amount, password);

    expect(shouldAnnotateRemoteEditable(customer)).toBe(true);
    expect(shouldAnnotateRemoteEditable(supplier)).toBe(true);
    expect(shouldAnnotateRemoteEditable(item)).toBe(true);
    expect(shouldAnnotateRemoteEditable(amount)).toBe(false);
    expect(shouldAnnotateRemoteEditable(password)).toBe(false);

    annotateRemoteControlSurface(document);
    expect(customer.dataset.remoteControlEditable).toBe("true");
    expect(supplier.dataset.remoteControlEditable).toBe("true");
    expect(item.dataset.remoteControlEditable).toBe("true");
    expect(amount.dataset.remoteControlEditable).toBeUndefined();
    expect(password.dataset.remoteControlEditable).toBeUndefined();
  });

  it("marks same-origin real-sidebar navigation and leaves external links alone", () => {
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    const internal = document.createElement("a");
    internal.href = "/inventory";
    internal.textContent = "Inventory";
    const external = document.createElement("a");
    external.href = "https://example.com";
    external.textContent = "External";
    const section = document.createElement("button");
    section.dataset.testid = "button-sidebar-section-inventory";
    section.textContent = "Inventory section";
    sidebar.append(internal, external, section);
    document.body.appendChild(sidebar);

    annotateRemoteControlSurface(document);

    expect(internal.dataset.remoteControlAction).toBe("navigation");
    expect(internal.dataset.remoteControlSafe).toBe("true");
    expect(external.dataset.remoteControlAction).toBeUndefined();
    expect(section.dataset.remoteControlAction).toBe("navigation");
  });

  it("does not mark unrelated aside navigation", () => {
    const unrelated = document.createElement("aside");
    const link = document.createElement("a");
    link.href = "/reports";
    link.textContent = "Reports";
    unrelated.appendChild(link);
    document.body.appendChild(unrelated);

    annotateRemoteControlSurface(document);
    expect(link.dataset.remoteControlAction).toBeUndefined();
  });

  it("does not override protected containers", () => {
    const blocked = document.createElement("div");
    blocked.dataset.remoteControlBlocked = "true";
    const input = document.createElement("input");
    input.placeholder = "Search by name";
    const link = document.createElement("a");
    link.href = "/accounts";
    blocked.append(input, link);
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    sidebar.appendChild(blocked);
    document.body.appendChild(sidebar);

    annotateRemoteControlSurface(document);

    expect(input.dataset.remoteControlEditable).toBeUndefined();
    expect(link.dataset.remoteControlAction).toBeUndefined();
  });

  it("is idempotent and does not rewrite existing coverage attributes", () => {
    const input = document.createElement("input");
    input.placeholder = "Search by name";
    document.body.appendChild(input);
    const setAttribute = vi.spyOn(input, "setAttribute");

    annotateRemoteControlSurface(input);
    annotateRemoteControlSurface(input);

    expect(input.dataset.remoteControlEditable).toBe("true");
    expect(
      setAttribute.mock.calls.filter(
        ([name, value]) => name === "data-remote-control-editable" && value === "true"
      )
    ).toHaveLength(1);
  });

  it("coalesces child-list mutations into one animation frame and scopes work to added subtrees", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn(() => undefined));

    const dispose = installRemoteControlSurfaceCoverage(document.body);
    const first = document.createElement("div");
    const firstInput = document.createElement("input");
    firstInput.placeholder = "Customer name";
    first.appendChild(firstInput);
    const second = document.createElement("div");
    const secondInput = document.createElement("input");
    secondInput.placeholder = "Supplier code";
    second.appendChild(secondInput);

    document.body.append(first, second);
    await Promise.resolve();

    expect(callbacks).toHaveLength(1);
    callbacks[0]?.(0);
    expect(firstInput.dataset.remoteControlEditable).toBe("true");
    expect(secondInput.dataset.remoteControlEditable).toBe("true");

    dispose();
  });
});
