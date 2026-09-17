// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteMouseControllerOverlay } from "./RemoteMouseControllerOverlay";

const controllerState = vi.hoisted(() => {
  const requestJson = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
  return {
    session: null as Record<string, unknown> | null,
    target: null as Record<string, unknown> | null,
    portalHost: null as HTMLElement | null,
    refreshSession: vi.fn(async () => undefined),
    requestJson,
  };
});

vi.mock("@/components/RemoteControllerSessionContext", () => ({
  RemoteControllerRequestError: class RemoteControllerRequestError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string | null
    ) {
      super(message);
    }
  },
  remoteControllerRequestJson: (...args: unknown[]) => controllerState.requestJson(...args),
  useRemoteControllerSession: () => ({
    target: controllerState.target,
    session: controllerState.session,
    portalHost: controllerState.portalHost,
    refreshSession: controllerState.refreshSession,
  }),
}));

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ language: "en" }),
}));

class FakeEventSource {
  close() {}
  addEventListener() {}
}

interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  clientX?: number;
  clientY?: number;
}

function fireWheel(element: Element, init: WheelInit) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "deltaX", { value: init.deltaX ?? 0 });
  Object.defineProperty(event, "deltaY", { value: init.deltaY ?? 0 });
  Object.defineProperty(event, "deltaMode", { value: init.deltaMode ?? 0 });
  element.dispatchEvent(event);
}

function fireClick(element: Element, clientX: number, clientY: number) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX, clientY }));
}

/**
 * Builds the viewer DOM the overlay binds to: a watch dialog containing the
 * screen image (with a captured-frame snapshot stamped on it) and the portal
 * host the control panel renders into.
 *
 * The image element is 1000×700 while the captured frame viewport is
 * 1000×600, so the frame is letterboxed: the frame pixels occupy
 * (0, 50)–(1000, 650). jsdom images never decode, so naturalWidth is 0 and
 * the overlay must fall back to the dataset snapshot for the frame size.
 */
function setupViewerDialog() {
  const dialog = document.createElement("section");
  dialog.setAttribute("data-testid", "dialog-watch-user");
  dialog.dataset.watchedUserId = "22";

  const image = document.createElement("img");
  image.setAttribute("data-testid", "img-screen-feed");
  image.dataset.frameViewportWidth = "1000";
  image.dataset.frameViewportHeight = "600";
  image.dataset.frameViewportScrollX = "0";
  image.dataset.frameViewportScrollY = "240";
  image.dataset.frameViewportVisualScale = "1";
  image.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0 }) as DOMRect;
  dialog.appendChild(image);

  const portalHost = document.createElement("div");
  dialog.appendChild(portalHost);
  document.body.appendChild(dialog);

  controllerState.session = {
    id: "session-1",
    targetUserId: "22",
    targetUsername: "employee",
    capabilities: { mouse: true, keyboard: false },
    mouseAuthorization: { expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
  };
  controllerState.target = { userId: "22", username: "employee" };
  controllerState.portalHost = portalHost;

  return { image, portalHost };
}

function postedPayloads(): Array<Record<string, unknown>> {
  return controllerState.requestJson.mock.calls.map((call) => {
    const body = (call[1] as { body?: string } | undefined)?.body;
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  });
}

describe("RemoteMouseControllerOverlay input wiring", () => {
  beforeEach(() => {
    controllerState.requestJson.mockClear();
    controllerState.refreshSession.mockClear();
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    controllerState.session = null;
    controllerState.target = null;
    controllerState.portalHost = null;
    vi.unstubAllGlobals();
  });

  it("sends line-mode wheel deltas as pixels", async () => {
    const { image } = setupViewerDialog();
    render(<RemoteMouseControllerOverlay />);

    // Firefox reports ~3 lines per notch; the target must receive 120 px.
    fireWheel(image, { deltaX: 0, deltaY: 3, deltaMode: 1, clientX: 500, clientY: 350 });

    await waitFor(
      () => {
        expect(postedPayloads()).toEqual([expect.objectContaining({ type: "scroll", deltaX: 0, deltaY: 120 })]);
      },
      { timeout: 2000 }
    );
  });

  it("sends page-mode wheel deltas scaled by the captured frame's page size", async () => {
    const { image } = setupViewerDialog();
    render(<RemoteMouseControllerOverlay />);

    fireWheel(image, { deltaX: 0, deltaY: -1, deltaMode: 2, clientX: 500, clientY: 350 });

    await waitFor(
      () => {
        expect(postedPayloads()).toEqual([expect.objectContaining({ type: "scroll", deltaX: 0, deltaY: -600 })]);
      },
      { timeout: 2000 }
    );
  });

  it("keeps pixel-mode wheel deltas untouched", async () => {
    const { image } = setupViewerDialog();
    render(<RemoteMouseControllerOverlay />);

    fireWheel(image, { deltaX: 4, deltaY: -100, deltaMode: 0, clientX: 500, clientY: 350 });

    await waitFor(
      () => {
        expect(postedPayloads()).toEqual([expect.objectContaining({ type: "scroll", deltaX: 4, deltaY: -100 })]);
      },
      { timeout: 2000 }
    );
  });

  it("stamps click and scroll commands with the frame viewport snapshot", async () => {
    const { image } = setupViewerDialog();
    render(<RemoteMouseControllerOverlay />);

    fireWheel(image, { deltaX: 0, deltaY: 3, deltaMode: 1, clientX: 500, clientY: 350 });

    await waitFor(
      () => {
        expect(postedPayloads()).toEqual([expect.objectContaining({ type: "scroll", deltaX: 0, deltaY: 120 })]);
      },
      { timeout: 2000 }
    );

    // Click the center of the letterboxed frame content (y 50..650).
    fireClick(image, 500, 350);
    await waitFor(
      () => {
        expect(postedPayloads()).toHaveLength(2);
      },
      { timeout: 2000 }
    );

    const frameViewport = { width: 1000, height: 600, scrollX: 0, scrollY: 240, visualScale: 1 };
    expect(postedPayloads()[0]).toMatchObject({ type: "scroll", x: 0.5, y: 0.5, frameViewport });
    expect(postedPayloads()[1]).toMatchObject({ type: "click", x: 0.5, y: 0.5, frameViewport });

    // A click in the letterbox bar is outside the frame coordinate space.
    controllerState.requestJson.mockClear();
    fireClick(image, 500, 25);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(postedPayloads()).toEqual([]);
  });
});
