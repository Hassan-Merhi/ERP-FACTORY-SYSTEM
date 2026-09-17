// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  annotateRemoteControlSurface,
  shouldAnnotateRemoteEditable,
} from "./remote-control-surface-coverage";

describe("remote control surface coverage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/dashboard");
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

  it("marks same-origin sidebar navigation and leaves external links alone", () => {
    const sidebar = document.createElement("aside");
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

  it("does not override protected containers", () => {
    const blocked = document.createElement("div");
    blocked.dataset.remoteControlBlocked = "true";
    const input = document.createElement("input");
    input.placeholder = "Search by name";
    const link = document.createElement("a");
    link.href = "/accounts";
    blocked.append(input, link);
    const sidebar = document.createElement("aside");
    sidebar.appendChild(blocked);
    document.body.appendChild(sidebar);

    annotateRemoteControlSurface(document);

    expect(input.dataset.remoteControlEditable).toBeUndefined();
    expect(link.dataset.remoteControlAction).toBeUndefined();
  });
});
