// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemoteMouseCommand,
  getRemoteMouseViewportMetrics,
  isAllowedRemoteClickElement,
  isRemoteMouseBlockedElement,
  isRemoteMouseFrameViewportStale,
  mapRemoteMousePoint,
  normalizeRemoteMousePoint,
  parseFrameViewportFromDataset,
  type RemoteMouseCommandType,
  type RemoteMouseCommandView,
} from "./remote-mouse-control-policy";

function command(
  type: RemoteMouseCommandType,
  overrides: Partial<RemoteMouseCommandView> = {}
): RemoteMouseCommandView {
  return {
    id: "command-1",
    sessionId: "session-1",
    type,
    sequence: 1,
    x: 0.5,
    y: 0.5,
    ...overrides,
  };
}

describe("remote mouse execution policy", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("normalizes points only inside the displayed screen image", () => {
    expect(normalizeRemoteMousePoint(250, 150, { left: 0, top: 0, width: 500, height: 300 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(normalizeRemoteMousePoint(501, 150, { left: 0, top: 0, width: 500, height: 300 })).toBeNull();
    expect(normalizeRemoteMousePoint(10, 10, { left: 0, top: 0, width: 0, height: 300 })).toBeNull();
  });

  it("maps normalized points through the active visual viewport", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 120, offsetTop: 80, width: 500, height: 300, scale: 2 },
    });

    expect(getRemoteMouseViewportMetrics()).toEqual({
      left: 120,
      top: 80,
      width: 500,
      height: 300,
      scale: 2,
    });
    expect(mapRemoteMousePoint(0.5, 0.5)).toEqual({ clientX: 370, clientY: 230 });
    expect(mapRemoteMousePoint(1, 1)).toEqual({ clientX: 619, clientY: 379 });
  });

  it("uses the same viewport transform for pointer display and hit testing", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 40, offsetTop: 25, width: 800, height: 400, scale: 1.25 },
    });
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    expect(applyRemoteMouseCommand(command("click", { x: 0.25, y: 0.75 }))).toEqual({
      status: "executed",
      reason: null,
      clientX: 240,
      clientY: 325,
    });
    expect(document.elementFromPoint).toHaveBeenCalledWith(240, 325);
    expect(viewClick).toHaveBeenCalledTimes(1);
  });

  it("blocks fields, forms, disabled controls, and protected surfaces", () => {
    const form = document.createElement("form");
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    form.appendChild(viewButton);
    document.body.appendChild(form);

    const input = document.createElement("input");
    document.body.appendChild(input);
    const destructive = document.createElement("button");
    destructive.textContent = "Delete voucher";
    document.body.appendChild(destructive);
    const protectedControl = document.createElement("button");
    protectedControl.dataset.remoteControlBlocked = "true";
    protectedControl.textContent = "View";
    document.body.appendChild(protectedControl);

    expect(isRemoteMouseBlockedElement(viewButton)).toBe(true);
    expect(isRemoteMouseBlockedElement(input)).toBe(true);
    expect(isRemoteMouseBlockedElement(destructive)).toBe(true);
    expect(isRemoteMouseBlockedElement(protectedControl)).toBe(true);
  });

  it("allows safe tabs, read-only actions, and same-origin navigation", () => {
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.textContent = "Overview";
    document.body.appendChild(tab);

    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    document.body.appendChild(viewButton);

    const internalLink = document.createElement("a");
    internalLink.href = "/reports";
    internalLink.textContent = "Reports";
    document.body.appendChild(internalLink);

    const externalLink = document.createElement("a");
    externalLink.href = "https://outside.example.com/";
    externalLink.textContent = "Outside";
    document.body.appendChild(externalLink);

    expect(isAllowedRemoteClickElement(tab)).toBe(true);
    expect(isAllowedRemoteClickElement(viewButton)).toBe(true);
    expect(isAllowedRemoteClickElement(internalLink)).toBe(true);
    expect(isAllowedRemoteClickElement(externalLink)).toBe(false);
  });

  it("requires generic buttons to be explicitly allowlisted", () => {
    const generic = document.createElement("button");
    generic.textContent = "Run action";
    document.body.appendChild(generic);

    const explicitSafe = document.createElement("button");
    explicitSafe.dataset.remoteControlSafe = "true";
    explicitSafe.textContent = "Read-only inspector";
    document.body.appendChild(explicitSafe);

    expect(isAllowedRemoteClickElement(generic)).toBe(false);
    expect(isAllowedRemoteClickElement(explicitSafe)).toBe(true);
  });

  it("executes allowlisted clicks and blocks save or unknown actions", () => {
    const viewButton = document.createElement("button");
    viewButton.textContent = "View history";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    expect(applyRemoteMouseCommand(command("click"))).toEqual({
      status: "executed",
      reason: null,
      clientX: 500,
      clientY: 300,
    });
    expect(viewClick).toHaveBeenCalledTimes(1);

    const saveButton = document.createElement("button");
    saveButton.textContent = "Save changes";
    document.body.appendChild(saveButton);
    document.elementFromPoint = vi.fn(() => saveButton);
    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({
      status: "blocked",
      reason: "protected-element",
    });

    const unknownButton = document.createElement("button");
    unknownButton.textContent = "Run action";
    document.body.appendChild(unknownButton);
    document.elementFromPoint = vi.fn(() => unknownButton);
    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({
      status: "blocked",
      reason: "action-not-allowlisted",
    });
  });

  it("moves the visible support pointer without activating the page", () => {
    document.elementFromPoint = vi.fn(() => null);
    expect(applyRemoteMouseCommand(command("pointer-move", { x: 0.25, y: 0.75 }))).toEqual({
      status: "executed",
      reason: null,
      clientX: 250,
      clientY: 450,
    });
  });

  it("scrolls the nearest local scroll container before falling back to the window", () => {
    const container = document.createElement("div");
    container.style.overflowY = "auto";
    const child = document.createElement("span");
    container.appendChild(child);
    document.body.appendChild(container);
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    const scrollBy = vi.fn();
    container.scrollBy = scrollBy;
    document.elementFromPoint = vi.fn(() => child);

    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 0, deltaY: 240 }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 240, behavior: "auto" });

    const plainTarget = document.createElement("div");
    document.body.appendChild(plainTarget);
    document.elementFromPoint = vi.fn(() => plainTarget);
    const windowScrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 10, deltaY: 40 }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(windowScrollBy).toHaveBeenCalledWith({ left: 10, top: 40, behavior: "auto" });
  });

  it("bubbles scroll past an exhausted inner panel to a scrollable parent", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    const child = document.createElement("span");
    inner.appendChild(child);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    Object.defineProperties(inner, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 400 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    const innerScrollBy = vi.fn();
    const outerScrollBy = vi.fn();
    inner.scrollBy = innerScrollBy;
    outer.scrollBy = outerScrollBy;
    document.elementFromPoint = vi.fn(() => child);

    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 0, deltaY: 120 }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(innerScrollBy).not.toHaveBeenCalled();
    expect(outerScrollBy).toHaveBeenCalledWith({ left: 0, top: 120, behavior: "auto" });
  });

  it("maps clicks against the frame's captured scroll and viewport state", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    const frameViewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 };
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(viewClick).toHaveBeenCalledTimes(1);

    // The employee scrolled after the frame was captured: the normalized
    // coordinates now point at a different control, so the click must be
    // ignored instead of landing on whatever is there now.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "ignored",
      reason: "stale-frame-viewport",
    });
    expect(viewClick).toHaveBeenCalledTimes(1);

    // A resized or zoomed viewport invalidates the frame the same way.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "ignored",
      reason: "stale-frame-viewport",
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 0, offsetTop: 0, width: 1000, height: 600, scale: 2 },
    });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "ignored",
      reason: "stale-frame-viewport",
    });
    expect(viewClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the support pointer smooth when the frame viewport is stale", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 500 });
    document.elementFromPoint = vi.fn(() => null);
    // Pointer movement is display-only: it never activates a control, so it
    // skips the stale-frame check that gates clicks and scrolls.
    expect(
      applyRemoteMouseCommand(
        command("pointer-move", {
          x: 0.25,
          y: 0.75,
          frameViewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 },
        })
      )
    ).toEqual({ status: "executed", reason: null, clientX: 250, clientY: 450 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("executes legacy commands that carry no frame snapshot", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    expect(isRemoteMouseFrameViewportStale(undefined)).toBe(false);
    expect(isRemoteMouseFrameViewportStale(null)).toBe(false);
    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({ status: "executed" });
    expect(viewClick).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("reads the captured-frame snapshot stamped on the viewer image", () => {
    const image = document.createElement("img");
    image.dataset.frameViewportWidth = "1280";
    image.dataset.frameViewportHeight = "720";
    image.dataset.frameViewportScrollX = "0";
    image.dataset.frameViewportScrollY = "240";
    image.dataset.frameViewportVisualScale = "1";
    expect(parseFrameViewportFromDataset(image.dataset)).toEqual({
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 240,
      visualScale: 1,
    });

    const legacyImage = document.createElement("img");
    expect(parseFrameViewportFromDataset(legacyImage.dataset)).toBeUndefined();

    const partialImage = document.createElement("img");
    partialImage.dataset.frameViewportWidth = "1280";
    partialImage.dataset.frameViewportHeight = "720";
    expect(parseFrameViewportFromDataset(partialImage.dataset)).toBeUndefined();
  });

  it("never lets an explicit safe annotation override dangerous or blocked controls", () => {
    const dangerousSafe = document.createElement("button");
    dangerousSafe.dataset.remoteControlSafe = "true";
    dangerousSafe.textContent = "Delete voucher";
    document.body.appendChild(dangerousSafe);

    const form = document.createElement("form");
    const formSafe = document.createElement("button");
    formSafe.dataset.remoteControlSafe = "true";
    formSafe.textContent = "View details";
    form.appendChild(formSafe);
    document.body.appendChild(form);

    expect(isRemoteMouseBlockedElement(dangerousSafe)).toBe(true);
    expect(isAllowedRemoteClickElement(dangerousSafe)).toBe(false);
    expect(isAllowedRemoteClickElement(formSafe)).toBe(false);
  });

  it("ignores malformed coordinates, empty scrolls, and missing targets", () => {
    document.elementFromPoint = vi.fn(() => null);
    expect(applyRemoteMouseCommand(command("click", { x: 2 }))).toMatchObject({
      status: "ignored",
      reason: "invalid-coordinates",
    });
    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({
      status: "ignored",
      reason: "no-target",
    });

    const target = document.createElement("div");
    document.body.appendChild(target);
    document.elementFromPoint = vi.fn(() => target);
    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 0, deltaY: 0 }))).toMatchObject({
      status: "ignored",
      reason: "empty-scroll",
    });
  });
});
