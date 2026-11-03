// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { acquireRemoteControlPanelHost, releaseRemoteControlPanelHost } from "./remote-control-panel-portal";

describe("remote control panel placement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the modern Watch User sidebar instead of stealing live-screen width", () => {
    const dialog = document.createElement("div");
    const slot = document.createElement("div");
    slot.setAttribute("data-screen-feed-control-slot", "");
    dialog.appendChild(slot);
    document.body.appendChild(dialog);

    const host = acquireRemoteControlPanelHost(dialog);
    expect(host.parentElement).toBe(slot);
    expect(host.dataset.remoteControlPanelMode).toBe("unified");
    expect(dialog.classList.contains("lg:pr-[376px]!")).toBe(false);

    releaseRemoteControlPanelHost(host);
    expect(slot.children.length).toBe(0);
  });

  it("preserves legacy viewers without a sidebar slot", () => {
    const dialog = document.createElement("div");
    document.body.appendChild(dialog);
    const host = acquireRemoteControlPanelHost(dialog);
    expect(host.parentElement).toBe(dialog);
    expect(dialog.classList.contains("lg:pr-[376px]!")).toBe(true);
    releaseRemoteControlPanelHost(host);
    expect(dialog.classList.contains("lg:pr-[376px]!")).toBe(false);
  });
});
