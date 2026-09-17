// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemoteMouseCommand,
  getRemoteMouseFrameContentBox,
  getRemoteMouseViewportMetrics,
  isAllowedRemoteClickElement,
  isRemoteMouseBlockedElement,
  isUsableRemoteMouseViewport,
  mapRemoteMouseFramePoint,
  normalizeRemoteMousePoint,
  normalizeRemoteWheelDelta,
  parseFrameViewportFromDataset,
  REMOTE_WHEEL_DELTA_MODE_LINE,
  REMOTE_WHEEL_DELTA_MODE_PAGE,
  REMOTE_WHEEL_DELTA_MODE_PIXEL,
  REMOTE_WHEEL_FALLBACK_PAGE_WIDTH_PX,
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

  it("normalizes pointer input against the frame's rendered content box", () => {
    // A 1000×700 element letterboxing a 1000×600 frame leaves 50px bars top
    // and bottom; coordinates must be taken against the frame pixels, not the
    // element rect.
    const rect = { left: 0, top: 0, width: 1000, height: 700 };
    expect(getRemoteMouseFrameContentBox(rect, { width: 1000, height: 600 })).toEqual({
      left: 0,
      top: 50,
      width: 1000,
      height: 600,
    });
    expect(normalizeRemoteMousePoint(500, 350, rect, { width: 1000, height: 600 })).toEqual({ x: 0.5, y: 0.5 });
    // The letterbox bars are outside the frame's coordinate space.
    expect(normalizeRemoteMousePoint(500, 25, rect, { width: 1000, height: 600 })).toBeNull();
    expect(normalizeRemoteMousePoint(500, 675, rect, { width: 1000, height: 600 })).toBeNull();
    // Without a frame size the element rect remains the space (legacy viewers).
    expect(normalizeRemoteMousePoint(500, 350, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(
      getRemoteMouseFrameContentBox({ left: 0, top: 0, width: 0, height: 700 }, { width: 1000, height: 600 })
    ).toBeNull();
    expect(getRemoteMouseFrameContentBox(rect, { width: 0, height: 600 })).toBeNull();
  });

  it("maps normalized points in one layout-viewport coordinate space", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 120, offsetTop: 80, width: 500, height: 300, scale: 2 },
    });

    // The captured frame is the layout viewport (innerWidth/innerHeight at
    // scrollX/scrollY). The visual viewport is a different space and must not
    // shift or rescale the mapping, or clicks land away from where the
    // controller aimed.
    expect(getRemoteMouseViewportMetrics()).toEqual({ width: 1000, height: 600, scrollX: 0, scrollY: 0 });
    expect(mapRemoteMouseFramePoint(0.5, 0.5, undefined)).toEqual({ clientX: 500, clientY: 300, onScreen: true });
    expect(mapRemoteMouseFramePoint(1, 1, undefined)).toEqual({ clientX: 999, clientY: 599, onScreen: true });
    expect(mapRemoteMouseFramePoint(2, 0.5, undefined)).toBeNull();
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
      clientX: 250,
      clientY: 450,
    });
    expect(document.elementFromPoint).toHaveBeenCalledWith(250, 450);
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

  it("remaps clicks through the frame snapshot instead of rejecting them", () => {
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    const frameViewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 };
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "executed",
      reason: null,
      clientX: 500,
      clientY: 300,
    });
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(500, 300);
    expect(viewClick).toHaveBeenCalledTimes(1);

    // The employee scrolled 240px after the frame was captured. The content
    // the controller aimed at moved up by exactly 240px, so the click is
    // remapped to the same document position and still executes instead of
    // being rejected as a stale frame.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "executed",
      reason: null,
      clientX: 500,
      clientY: 60,
    });
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(500, 60);
    expect(viewClick).toHaveBeenCalledTimes(2);

    // Horizontal scroll drift remaps the same way.
    Object.defineProperty(window, "scrollX", { configurable: true, value: 60 });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "executed",
      clientX: 440,
      clientY: 60,
    });

    // A resize or zoom no longer invalidates the frame: the point is remapped
    // through document space as a best effort rather than dropped.
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({ status: "executed" });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 0, offsetTop: 0, width: 1000, height: 600, scale: 2 },
    });
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({ status: "executed" });
    expect(viewClick).toHaveBeenCalledTimes(5);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });

  it("ignores clicks whose remapped aim point left the live viewport", () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    // y = 0.5 on a frame captured at scroll 0 → document y 300 → 100px above
    // the live viewport: the aimed content is no longer visible, so there is
    // nothing accurate to click.
    const frameViewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 };
    expect(applyRemoteMouseCommand(command("click", { frameViewport }))).toMatchObject({
      status: "ignored",
      reason: "frame-point-offscreen",
    });
    expect(viewClick).not.toHaveBeenCalled();
  });

  it("keeps scrolling working against a frame the scroll itself made stale", () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
    document.elementFromPoint = vi.fn(() => document.body);
    const windowScrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const frameViewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 };

    // The page already scrolled 240px since the frame was captured — a scroll
    // command must still execute, or remote scrolling would die after the
    // first command and only recover when the next frame arrived.
    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 0, deltaY: 120, frameViewport }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(windowScrollBy).toHaveBeenCalledWith({ left: 0, top: 120, behavior: "auto" });
    // The anchor is still remapped through the snapshot: 0.5/0.5 at frame
    // scroll 0 → document y 300 → live clientY 60.
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(500, 60);

    // A resized frame is equally no reason to drop the scroll.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    expect(applyRemoteMouseCommand(command("scroll", { deltaX: 0, deltaY: 120, frameViewport }))).toMatchObject({
      status: "executed",
      reason: null,
    });
    expect(windowScrollBy).toHaveBeenCalledTimes(2);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  });

  it("keeps the support pointer smooth and on screen when the frame viewport is stale", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 500 });
    document.elementFromPoint = vi.fn(() => null);
    // Pointer movement is display-only: it never activates a control, and it
    // stays clamped inside the live viewport even when the frame it was aimed
    // at has scrolled away underneath.
    expect(
      applyRemoteMouseCommand(
        command("pointer-move", {
          x: 0.25,
          y: 0.75,
          frameViewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 },
        })
      )
    ).toEqual({ status: "executed", reason: null, clientX: 250, clientY: 0 });
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

    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({ status: "executed" });
    expect(viewClick).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("falls back to live-viewport mapping when the frame snapshot is malformed", () => {
    const viewButton = document.createElement("button");
    viewButton.textContent = "View details";
    const viewClick = vi.spyOn(viewButton, "click").mockImplementation(() => {});
    document.body.appendChild(viewButton);
    document.elementFromPoint = vi.fn(() => viewButton);

    // A malformed snapshot is dropped, not rejected: the command keeps the
    // legacy live-viewport mapping.
    expect(
      applyRemoteMouseCommand(
        command("click", {
          frameViewport: { width: Number.NaN, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 },
        })
      )
    ).toMatchObject({ status: "executed", clientX: 500, clientY: 300 });
    expect(
      applyRemoteMouseCommand(
        command("click", {
          frameViewport: { width: 0, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 },
        })
      )
    ).toMatchObject({ status: "executed", clientX: 500, clientY: 300 });
    expect(viewClick).toHaveBeenCalledTimes(2);
  });

  it("normalizes wheel deltas to pixels for every deltaMode", () => {
    // Pixel-mode events pass through untouched.
    expect(normalizeRemoteWheelDelta(12, -40, REMOTE_WHEEL_DELTA_MODE_PIXEL)).toEqual({ deltaX: 12, deltaY: -40 });
    // Line-mode controllers (Firefox) report ~3 lines per notch.
    expect(normalizeRemoteWheelDelta(3, -3, REMOTE_WHEEL_DELTA_MODE_LINE)).toEqual({ deltaX: 120, deltaY: -120 });
    // Page-mode deltas are scaled by the target's page size.
    expect(normalizeRemoteWheelDelta(0, -2, REMOTE_WHEEL_DELTA_MODE_PAGE, 1000, 600)).toEqual({
      deltaX: 0,
      deltaY: -1200,
    });
    expect(normalizeRemoteWheelDelta(1, 0, REMOTE_WHEEL_DELTA_MODE_PAGE)).toEqual({
      deltaX: REMOTE_WHEEL_FALLBACK_PAGE_WIDTH_PX,
      deltaY: 0,
    });
    expect(normalizeRemoteWheelDelta(Number.NaN, 5, REMOTE_WHEEL_DELTA_MODE_PIXEL)).toEqual({ deltaX: 0, deltaY: 5 });
    expect(normalizeRemoteWheelDelta(2, 2, 99)).toEqual({ deltaX: 2, deltaY: 2 });
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

  it("scrolls the same distance whichever unit the controller's wheel reports", () => {
    const panel = document.createElement("div");
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 600 });
    panel.scrollTop = 500;
    panel.style.overflowY = "auto";
    document.body.appendChild(panel);
    document.elementFromPoint = vi.fn(() => panel);
    const scrollBy = vi.fn();
    panel.scrollBy = scrollBy;

    // One notch is ~120 px in every unit the controller may report, because the
    // controller converts to pixels before the command is sent.
    const pixel = normalizeRemoteWheelDelta(0, 120, REMOTE_WHEEL_DELTA_MODE_PIXEL);
    const line = normalizeRemoteWheelDelta(0, 3, REMOTE_WHEEL_DELTA_MODE_LINE);
    expect(line).toEqual(pixel);

    // A page-mode notch is one screenful of the frame the controller is viewing.
    const pageMode = normalizeRemoteWheelDelta(0, 1, REMOTE_WHEEL_DELTA_MODE_PAGE, 1000, 600);
    expect(pageMode).toEqual({ deltaX: 0, deltaY: 600 });

    for (const delta of [pixel, line, pageMode]) {
      expect(applyRemoteMouseCommand(command("scroll", { ...delta }))).toMatchObject({ status: "executed" });
    }
    expect(scrollBy.mock.calls.map(([options]) => options.top)).toEqual([120, 120, 600]);
  });

  it("scrolls at the point the controller aimed at, not the viewport centre", () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const elementFromPoint = vi.fn(() => panel);
    document.elementFromPoint = elementFromPoint;
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;

    applyRemoteMouseCommand(
      command("scroll", {
        x: 0.25,
        y: 0.75,
        deltaY: 120,
        frameViewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 },
      })
    );

    expect(elementFromPoint).toHaveBeenCalledWith(250, 450);
  });

  it("refuses commands aimed into a window that reports no viewport", () => {
    expect(isUsableRemoteMouseViewport(window)).toBe(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 0 });
    expect(isUsableRemoteMouseViewport(window)).toBe(false);

    const control = document.createElement("button");
    control.textContent = "View details";
    control.dataset.remoteControlAction = "view-details";
    document.body.appendChild(control);
    const click = vi.spyOn(control, "click");
    document.elementFromPoint = vi.fn(() => control);

    // A minimized or detached window would otherwise clamp every command onto
    // the top-left corner and activate whatever sits there.
    expect(applyRemoteMouseCommand(command("click"))).toMatchObject({
      status: "ignored",
      reason: "invalid-viewport",
    });
    expect(applyRemoteMouseCommand(command("scroll", { deltaY: 120 }))).toMatchObject({
      status: "ignored",
      reason: "invalid-viewport",
    });
    expect(click).not.toHaveBeenCalled();
  });

  it("recovers on the next frame after a reconnect left the aim point stale", () => {
    const control = document.createElement("button");
    control.textContent = "View details";
    control.dataset.remoteControlAction = "view-details";
    document.body.appendChild(control);
    const click = vi.spyOn(control, "click");
    document.elementFromPoint = vi.fn(() => control);

    // While the transport was down the employee scrolled a screenful, so the
    // frame the controller is still looking at aims off the live viewport.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1400 });
    const staleFrame = { width: 1000, height: 600, scrollX: 0, scrollY: 0, visualScale: 1 };
    expect(applyRemoteMouseCommand(command("click", { frameViewport: staleFrame }))).toMatchObject({
      status: "ignored",
      reason: "frame-point-offscreen",
    });
    expect(click).not.toHaveBeenCalled();

    // The first frame after the reconnect carries the employee's real scroll
    // position, and the same aim point lands again.
    const freshFrame = { width: 1000, height: 600, scrollX: 0, scrollY: 1400, visualScale: 1 };
    expect(applyRemoteMouseCommand(command("click", { frameViewport: freshFrame }))).toMatchObject({
      status: "executed",
      clientX: 500,
      clientY: 300,
    });
    expect(click).toHaveBeenCalledTimes(1);
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
