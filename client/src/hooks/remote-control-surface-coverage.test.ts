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
      setAttribute.mock.calls.filter(([name, value]) => name === "data-remote-control-editable" && value === "true")
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
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn(() => undefined)
    );

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

  it("discovers controls mounted into a dialog portal outside the app tree", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.appendChild(appRoot);
    const { dispose, flush } = installWithManualFrames();

    // Radix renders dialog content into a body-level portal, not under #root.
    const portal = document.createElement("div");
    portal.dataset.radixPortal = "";
    portal.innerHTML = `
      <div role="dialog" data-state="open">
        <input placeholder="Search by name" />
      </div>
    `;
    document.body.appendChild(portal);
    await flush();

    expect(portal.querySelector("input")?.dataset.remoteControlEditable).toBe("true");
    dispose();
  });

  it("discovers a dropdown portal and its nested sidebar navigation together", async () => {
    const { dispose, flush } = installWithManualFrames();

    const dropdown = document.createElement("div");
    dropdown.innerHTML = `
      <div role="menu" data-state="open" data-sidebar="content">
        <div class="group">
          <a href="/inventory">Inventory</a>
          <div class="nested"><input placeholder="Filter by code" /></div>
        </div>
      </div>
    `;
    document.body.appendChild(dropdown);
    await flush();

    expect(dropdown.querySelector("a")?.dataset.remoteControlAction).toBe("navigation");
    expect(dropdown.querySelector("input")?.dataset.remoteControlEditable).toBe("true");
    dispose();
  });

  it("annotates every open portal without re-scanning the page between them", async () => {
    const { dispose, flush } = installWithManualFrames();

    const dialog = document.createElement("div");
    dialog.innerHTML = `<div role="dialog" data-state="open"><input placeholder="Search by name" /></div>`;
    const menu = document.createElement("div");
    menu.innerHTML = `<div role="menu" data-state="open"><input placeholder="Filter by reference" /></div>`;
    document.body.append(dialog, menu);
    await flush();

    expect(dialog.querySelector("input")?.dataset.remoteControlEditable).toBe("true");
    expect(menu.querySelector("input")?.dataset.remoteControlEditable).toBe("true");
    dispose();
  });

  it("ignores controls kept mounted but hidden by a closed portal", async () => {
    const { dispose, flush } = installWithManualFrames();

    const closedPortal = document.createElement("div");
    closedPortal.innerHTML = `
      <div role="dialog" data-state="closed"><input placeholder="Search by name" /></div>
      <div hidden><input placeholder="Filter by code" /></div>
      <div style="display: none"><input placeholder="Search by reference" /></div>
      <div aria-hidden="true"><a href="/reports">Reports</a></div>
    `;
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    sidebar.append(...Array.from(closedPortal.children));
    document.body.appendChild(sidebar);
    await flush();

    expect(sidebar.querySelectorAll("[data-remote-control-editable]")).toHaveLength(0);
    expect(sidebar.querySelectorAll("[data-remote-control-action]")).toHaveLength(0);
    dispose();
  });

  it("leaves disabled controls out of the surface", () => {
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    sidebar.innerHTML = `
      <input placeholder="Search by name" disabled />
      <a href="/reports" aria-disabled="true">Reports</a>
      <button aria-expanded="false" disabled>Inventory section</button>
    `;
    document.body.appendChild(sidebar);

    annotateRemoteControlSurface(document);

    expect(sidebar.querySelectorAll("[data-remote-control-editable]")).toHaveLength(0);
    expect(sidebar.querySelectorAll("[data-remote-control-action]")).toHaveLength(0);
  });

  it("re-evaluates a control whose gating attributes change after mount", async () => {
    const { dispose, flush } = installWithManualFrames();

    const field = document.createElement("input");
    field.placeholder = "Search by name";
    field.disabled = true;
    document.body.appendChild(field);
    await flush();
    expect(field.dataset.remoteControlEditable).toBeUndefined();

    // The dialog finished loading and enabled its filter.
    field.disabled = false;
    await flush();
    expect(field.dataset.remoteControlEditable).toBe("true");

    // And the opposite direction: a stale opt-in must not survive.
    field.setAttribute("readonly", "");
    await flush();
    expect(field.dataset.remoteControlEditable).toBeUndefined();

    dispose();
  });

  it("never overwrites a navigation annotation the page authored itself", () => {
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    const link = document.createElement("a");
    link.href = "/containers/7";
    link.dataset.remoteControlAction = "view-container";
    link.dataset.remoteControlSafe = "true";
    sidebar.appendChild(link);
    document.body.appendChild(sidebar);

    annotateRemoteControlSurface(document);

    expect(link.dataset.remoteControlAction).toBe("view-container");
  });

  it("does not annotate ordinary ERP DOM churn outside the covered surface", async () => {
    const { dispose, flush } = installWithManualFrames();

    const table = document.createElement("div");
    table.innerHTML = `
      <table><tbody><tr><td><input placeholder="Unit price" /></td>
      <td><button>Post voucher</button></td></tr></tbody></table>
    `;
    document.body.appendChild(table);
    await flush();

    expect(table.querySelectorAll("[data-remote-control-editable]")).toHaveLength(0);
    expect(table.querySelectorAll("[data-remote-control-action]")).toHaveLength(0);
    dispose();
  });
});

/**
 * Installs the coverage observer with animation frames the test drives, so a
 * mutation's annotation pass is observable without waiting on a real frame.
 */
function installWithManualFrames(): { dispose: () => void; flush: () => Promise<void> } {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn(() => undefined)
  );

  const dispose = installRemoteControlSurfaceCoverage(document.body);
  return {
    dispose,
    flush: async () => {
      await Promise.resolve();
      while (callbacks.length > 0) callbacks.shift()?.(0);
    },
  };
}
