from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[2]


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_one(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match for {old!r}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


SURFACE = r'''const SAFE_FIELD_HINT = new RegExp(
  [
    "search",
    "filter",
    "find",
    "lookup",
    "query",
    "reference",
    "code",
    "name",
    "description",
    "from[\\s_-]*date",
    "to[\\s_-]*date",
    "start[\\s_-]*date",
    "end[\\s_-]*date",
    "rechercher",
    "filtrer",
    "chercher",
    "référence",
    "nom",
    "description",
    "بحث",
    "تصفية",
    "رمز",
    "اسم",
    "وصف",
  ].join("|"),
  "i"
);

const SENSITIVE_FIELD_HINT = new RegExp(
  [
    "password",
    "passcode",
    "one[\\s_-]*time",
    "otp",
    "secret",
    "token",
    "api[\\s_-]*key",
    "credit[\\s_-]*card",
    "card[\\s_-]*number",
    "cvv",
    "cvc",
    "iban",
    "swift",
    "routing",
    "bank[\\s_-]*account",
    "account[\\s_-]*number",
    "permission",
    "role",
    "payroll",
    "salary",
    "payment",
    "debit",
    "credit",
    "amount",
    "price",
    "cost",
    "exchange[\\s_-]*rate",
    "currency",
    "voucher",
    "transfer",
    "offload",
    "approval",
    "approve",
    "delete",
    "remove",
  ].join("|"),
  "i"
);

const SAFE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

const NAVIGATION_ROOT_SELECTOR = [
  "[data-sidebar='sidebar']",
  "[data-sidebar='content']",
  "[data-testid*='sidebar']",
  "nav",
  "header",
  "[role='navigation']",
  "[role='tablist']",
  "[role='menu']",
  "[role='toolbar']",
  "[cmdk-root]",
  "[data-command-menu]",
  "[data-testid*='command']",
  "[data-testid*='pagination']",
  "[data-testid*='toolbar']",
  "[data-testid*='tabs']",
  "[data-testid*='topbar']",
  "[data-testid*='header']",
].join(",");

const STRONG_NAVIGATION_ROOT_SELECTOR = [
  "[data-sidebar='sidebar']",
  "[data-sidebar='content']",
  "[data-testid*='sidebar']",
  "nav",
  "[role='navigation']",
  "[role='tablist']",
  "[role='menu']",
  "[cmdk-root]",
  "[data-command-menu]",
  "[data-testid*='command']",
  "[data-testid*='pagination']",
  "[data-testid*='tabs']",
].join(",");

const SAFE_NAV_TESTID_HINT = /(?:nav|sidebar|menu|command|tab|page|pagination|next|prev|previous|open|view|detail|row|breadcrumb|toolbar|back|forward|section|expand|collapse)/i;
const RISKY_TESTID_HINT = /(?:delete|remove|save|submit|approve|reject|payment|pay|transfer|offload|edit|create|new|reset|logout|signout|confirm|cancel)/i;
const RISKY_NAVIGATION_PATH = /\/(?:logout|signout|delete|remove|approve|payment|transfer|offload|reset)(?:\/|$)/i;

function fieldDescriptor(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const labels = element.labels ? Array.from(element.labels).map((label) => label.textContent ?? "").join(" ") : "";
  return [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isProtected(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      "[data-remote-control-blocked='true'],[data-sensitive-action],[data-destructive],[data-screenfeed-ignore='true']"
    )
  );
}

export function shouldAnnotateRemoteEditable(
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return false;
  }
  if (element.disabled || isProtected(element)) return false;
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) return false;

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (!SAFE_INPUT_TYPES.has(type)) return false;
    if (["password", "hidden", "file", "checkbox", "radio"].includes(type)) return false;
  }

  const descriptor = fieldDescriptor(element);
  if (!descriptor || SENSITIVE_FIELD_HINT.test(descriptor)) return false;
  return SAFE_FIELD_HINT.test(descriptor);
}

function sameOriginNavigation(anchor: HTMLAnchorElement, location: Location): boolean {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return false;
  if (anchor.hasAttribute("download") || anchor.target === "_blank") return false;
  try {
    const target = new URL(href, location.href);
    return target.origin === location.origin && !RISKY_NAVIGATION_PATH.test(target.pathname);
  } catch {
    return false;
  }
}

function navigationRoots(root: ParentNode): Element[] {
  const roots = Array.from(root.querySelectorAll(NAVIGATION_ROOT_SELECTOR));
  if (root instanceof Element && root.matches(NAVIGATION_ROOT_SELECTOR)) roots.unshift(root);
  return [...new Set(roots)];
}

function stableControlDescriptor(element: HTMLElement): string {
  return [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();
}

function safeNavigationButton(button: HTMLElement): boolean {
  if (isProtected(button) || button.getAttribute("aria-disabled") === "true") return false;
  if (button instanceof HTMLButtonElement && button.disabled) return false;

  const testId = button.getAttribute("data-testid") ?? "";
  if (RISKY_TESTID_HINT.test(testId)) return false;
  if (testId && SAFE_NAV_TESTID_HINT.test(testId)) return true;

  const role = button.getAttribute("role");
  if (role === "tab" || role === "menuitem") return true;
  if (button.hasAttribute("aria-controls") || button.hasAttribute("aria-expanded") || button.hasAttribute("aria-haspopup")) {
    return stableControlDescriptor(button).length > 0;
  }

  const strongRoot = button.closest(STRONG_NAVIGATION_ROOT_SELECTOR);
  return Boolean(strongRoot && stableControlDescriptor(button));
}

function annotateNavigationControl(element: HTMLElement): void {
  element.setAttribute("data-remote-control-action", "navigation");
  element.setAttribute("data-remote-control-safe", "true");
}

export function annotateRemoteControlSurface(root: ParentNode = document): void {
  root.querySelectorAll("input,textarea,select").forEach((element) => {
    if (shouldAnnotateRemoteEditable(element)) {
      element.setAttribute("data-remote-control-editable", "true");
    }
  });

  for (const landmark of navigationRoots(root)) {
    landmark.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      if (sameOriginNavigation(anchor, window.location) && !isProtected(anchor)) annotateNavigationControl(anchor);
    });
    landmark
      .querySelectorAll<HTMLElement>("button,[role='tab'],[role='menuitem']")
      .forEach((button) => {
        if (safeNavigationButton(button)) annotateNavigationControl(button);
      });
  }

  root
    .querySelectorAll<HTMLElement>(
      "button[data-testid],button[aria-controls],button[aria-expanded],button[aria-haspopup],[role='tab'],[role='menuitem'][data-testid]"
    )
    .forEach((button) => {
      if (safeNavigationButton(button)) annotateNavigationControl(button);
    });

  root.querySelectorAll<HTMLAnchorElement>("a[href][data-testid]").forEach((anchor) => {
    const testId = anchor.getAttribute("data-testid") ?? "";
    if (
      SAFE_NAV_TESTID_HINT.test(testId) &&
      !RISKY_TESTID_HINT.test(testId) &&
      sameOriginNavigation(anchor, window.location) &&
      !isProtected(anchor)
    ) {
      annotateNavigationControl(anchor);
    }
  });
}

export function installRemoteControlSurfaceCoverage(root: HTMLElement = document.body): () => void {
  annotateRemoteControlSurface(root);
  const observer = new MutationObserver(() => annotateRemoteControlSurface(root));
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
'''

SURFACE_TEST = r'''// @vitest-environment jsdom
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

  it("covers app-shell, tab, toolbar, pagination and row-open controls outside the sidebar", () => {
    const topNav = document.createElement("nav");
    topNav.setAttribute("aria-label", "التنقل الرئيسي");
    const topLink = document.createElement("a");
    topLink.href = "/accounts";
    topLink.textContent = "Comptes";
    topNav.appendChild(topLink);

    const tabs = document.createElement("div");
    tabs.setAttribute("role", "tablist");
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-label", "المخزون");
    tabs.appendChild(tab);

    const toolbar = document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    const menu = document.createElement("button");
    menu.setAttribute("aria-label", "Ouvrir le menu");
    menu.setAttribute("aria-controls", "command-menu");
    toolbar.appendChild(menu);

    const pager = document.createElement("div");
    pager.dataset.testid = "table-pagination";
    const next = document.createElement("button");
    next.title = "التالي";
    next.dataset.testid = "pagination-next";
    pager.appendChild(next);

    const rowOpen = document.createElement("button");
    rowOpen.dataset.testid = "button-view-row-42";

    document.body.append(topNav, tabs, toolbar, pager, rowOpen);
    annotateRemoteControlSurface(document);

    for (const control of [topLink, tab, menu, next, rowOpen]) {
      expect(control.dataset.remoteControlAction).toBe("navigation");
      expect(control.dataset.remoteControlSafe).toBe("true");
    }
  });

  it("does not use visible text as a navigation classifier", () => {
    const shell = document.createElement("header");
    const textOnly = document.createElement("button");
    textOnly.textContent = "Next / Suivant / التالي";
    shell.appendChild(textOnly);
    document.body.appendChild(shell);

    annotateRemoteControlSurface(document);
    expect(textOnly.dataset.remoteControlAction).toBeUndefined();
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

  it("does not override protected or destructive-looking controls", () => {
    const blocked = document.createElement("div");
    blocked.dataset.remoteControlBlocked = "true";
    const input = document.createElement("input");
    input.placeholder = "Search by name";
    const link = document.createElement("a");
    link.href = "/accounts";
    blocked.append(input, link);

    const toolbar = document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    const destructive = document.createElement("button");
    destructive.dataset.testid = "button-delete-row";
    destructive.setAttribute("aria-label", "Delete");
    toolbar.appendChild(destructive);

    const sidebar = document.createElement("div");
    sidebar.dataset.sidebar = "sidebar";
    sidebar.appendChild(blocked);
    document.body.append(sidebar, toolbar);

    annotateRemoteControlSurface(document);

    expect(input.dataset.remoteControlEditable).toBeUndefined();
    expect(link.dataset.remoteControlAction).toBeUndefined();
    expect(destructive.dataset.remoteControlAction).toBeUndefined();
  });
});
'''

TRANSPORT = r'''export const REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION = 2 as const;
export const REMOTE_SUPPORT_BINARY_PREFIX_BYTES = 5;
export const REMOTE_SUPPORT_MAX_HEADER_BYTES = 24 * 1024;
export const REMOTE_SUPPORT_MAX_FRAME_BYTES = 900_000;

export type RemoteSupportBinaryProtocolVersion = 1 | 2;

export interface RemoteSupportFrameHeader {
  type: "screen-feed-frame";
  version: RemoteSupportBinaryProtocolVersion;
  tabId: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface DecodedRemoteSupportBinaryPacket {
  header: RemoteSupportFrameHeader;
  payload: Uint8Array;
}

function supportedProtocolVersion(value: number): value is RemoteSupportBinaryProtocolVersion {
  return value === 1 || value === REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION;
}

function validHeader(value: unknown, packetVersion: RemoteSupportBinaryProtocolVersion): value is RemoteSupportFrameHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Partial<RemoteSupportFrameHeader>;
  return (
    header.type === "screen-feed-frame" &&
    header.version === packetVersion &&
    typeof header.tabId === "string" &&
    header.tabId.length > 0 &&
    header.tabId.length <= 160 &&
    typeof header.capturedAt === "string" &&
    !!header.metadata &&
    typeof header.metadata === "object" &&
    !Array.isArray(header.metadata)
  );
}

/**
 * Packet layout: [version:1][headerLength:4 big-endian][UTF-8 JSON header][JPEG].
 * Current producers emit v2. Decoders deliberately retain v1 compatibility for
 * independently deployed Capacitor clients, but the prefix/header versions must
 * always agree. v2 is the first contract that permits negative RTL scrollX.
 */
export function encodeRemoteSupportBinaryPacket(
  header: RemoteSupportFrameHeader,
  payload: Uint8Array
): Uint8Array {
  if (header.version !== REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION) {
    throw new Error("Remote support producers must emit the current protocol version.");
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > REMOTE_SUPPORT_MAX_HEADER_BYTES) throw new Error("Remote support header is too large.");
  if (payload.byteLength > REMOTE_SUPPORT_MAX_FRAME_BYTES) throw new Error("Remote support frame is too large.");
  const packet = new Uint8Array(REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.byteLength + payload.byteLength);
  packet[0] = REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION;
  new DataView(packet.buffer).setUint32(1, headerBytes.byteLength, false);
  packet.set(headerBytes, REMOTE_SUPPORT_BINARY_PREFIX_BYTES);
  packet.set(payload, REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.byteLength);
  return packet;
}

export function decodeRemoteSupportBinaryPacket(packet: Uint8Array): DecodedRemoteSupportBinaryPacket | null {
  if (packet.byteLength < REMOTE_SUPPORT_BINARY_PREFIX_BYTES) return null;
  const packetVersion = packet[0];
  if (!supportedProtocolVersion(packetVersion)) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const headerLength = view.getUint32(1, false);
  if (headerLength <= 0 || headerLength > REMOTE_SUPPORT_MAX_HEADER_BYTES) return null;
  const payloadOffset = REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerLength;
  if (payloadOffset > packet.byteLength) return null;
  const payloadLength = packet.byteLength - payloadOffset;
  if (payloadLength <= 0 || payloadLength > REMOTE_SUPPORT_MAX_FRAME_BYTES) return null;

  try {
    const headerRaw = new TextDecoder().decode(packet.subarray(REMOTE_SUPPORT_BINARY_PREFIX_BYTES, payloadOffset));
    const header = JSON.parse(headerRaw) as unknown;
    if (!validHeader(header, packetVersion)) return null;
    return { header, payload: packet.subarray(payloadOffset) };
  } catch {
    return null;
  }
}
'''

TRANSPORT_TEST = r'''import { describe, expect, it } from "vitest";
import {
  decodeRemoteSupportBinaryPacket,
  encodeRemoteSupportBinaryPacket,
  REMOTE_SUPPORT_BINARY_PREFIX_BYTES,
  REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION,
  REMOTE_SUPPORT_MAX_FRAME_BYTES,
  REMOTE_SUPPORT_MAX_HEADER_BYTES,
  type RemoteSupportBinaryProtocolVersion,
  type RemoteSupportFrameHeader,
} from "../shared/remoteSupportTransport";

function header(overrides: Partial<RemoteSupportFrameHeader> = {}): RemoteSupportFrameHeader {
  return {
    type: "screen-feed-frame",
    version: REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION,
    tabId: "tab-a",
    capturedAt: "2026-09-17T10:00:00.000Z",
    metadata: {
      viewport: { width: 1280, height: 720, scrollX: -140, scrollY: 100 },
      capture: { quality: 0.7, encodedBytes: 6 },
    },
    ...overrides,
  };
}

function packetForVersion(version: RemoteSupportBinaryProtocolVersion, payload = new Uint8Array([1, 2, 3])): Uint8Array {
  const legacyHeader: RemoteSupportFrameHeader = { ...header(), version };
  const headerBytes = new TextEncoder().encode(JSON.stringify(legacyHeader));
  const packet = new Uint8Array(REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.length + payload.length);
  packet[0] = version;
  new DataView(packet.buffer).setUint32(1, headerBytes.length, false);
  packet.set(headerBytes, REMOTE_SUPPORT_BINARY_PREFIX_BYTES);
  packet.set(payload, REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.length);
  return packet;
}

describe("remote support binary frame protocol", () => {
  it("round-trips the v2 metadata header, negative RTL scrollX, and raw JPEG bytes exactly", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const packet = encodeRemoteSupportBinaryPacket(header(), jpeg);
    const decoded = decodeRemoteSupportBinaryPacket(packet);

    expect(packet[0]).toBe(2);
    expect(decoded).not.toBeNull();
    expect(decoded?.header.tabId).toBe("tab-a");
    expect(decoded?.header.type).toBe("screen-feed-frame");
    expect(decoded?.header.version).toBe(REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION);
    expect((decoded?.header.metadata.viewport as { scrollX: number }).scrollX).toBe(-140);
    expect(decoded?.header.metadata).toEqual(header().metadata);
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(jpeg));
  });

  it("keeps different tab identities independent in the packet header", () => {
    const jpeg = new Uint8Array([1, 2, 3, 4]);
    const first = decodeRemoteSupportBinaryPacket(encodeRemoteSupportBinaryPacket(header({ tabId: "tab-a" }), jpeg));
    const second = decodeRemoteSupportBinaryPacket(encodeRemoteSupportBinaryPacket(header({ tabId: "tab-b" }), jpeg));

    expect(first?.header.tabId).toBe("tab-a");
    expect(second?.header.tabId).toBe("tab-b");
  });

  it("decodes legacy v1 packets while current producers remain v2-only", () => {
    const decoded = decodeRemoteSupportBinaryPacket(packetForVersion(1));
    expect(decoded?.header.version).toBe(1);
    expect(decoded?.header.tabId).toBe("tab-a");
    expect(() => encodeRemoteSupportBinaryPacket(header({ version: 1 }), new Uint8Array([1]))).toThrow(
      "current protocol version"
    );
  });

  it("rejects prefix/header version mismatches", () => {
    const v1 = packetForVersion(1);
    v1[0] = 2;
    expect(decodeRemoteSupportBinaryPacket(v1)).toBeNull();

    const v2 = packetForVersion(2);
    v2[0] = 1;
    expect(decodeRemoteSupportBinaryPacket(v2)).toBeNull();
  });

  it("rejects truncated, invalid-version, empty-payload, and invalid-header packets", () => {
    expect(decodeRemoteSupportBinaryPacket(new Uint8Array([2, 0, 0]))).toBeNull();

    const valid = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1, 2, 3]));
    const invalidVersion = valid.slice();
    invalidVersion[0] = 99;
    expect(decodeRemoteSupportBinaryPacket(invalidVersion)).toBeNull();

    const noPayload = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1]));
    expect(decodeRemoteSupportBinaryPacket(noPayload.subarray(0, noPayload.length - 1))).toBeNull();

    const badHeader = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1, 2]));
    const view = new DataView(badHeader.buffer, badHeader.byteOffset, badHeader.byteLength);
    view.setUint32(1, REMOTE_SUPPORT_MAX_HEADER_BYTES + 1, false);
    expect(decodeRemoteSupportBinaryPacket(badHeader)).toBeNull();
  });

  it("enforces the binary frame size limit before allocation/transport", () => {
    expect(() =>
      encodeRemoteSupportBinaryPacket(header(), new Uint8Array(REMOTE_SUPPORT_MAX_FRAME_BYTES + 1))
    ).toThrow("Remote support frame is too large.");
  });
});
'''

GENERATOR = r'''#!/usr/bin/env node
/**
 * Scanner / generator for the remote-control allowlist, editable coverage, and
 * per-route reachability ratchet.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CLIENT_SRC = join(ROOT, "client/src");
const REGISTRY_PATH = join(ROOT, "client/src/hooks/remote-control-action-registry.ts");
const ALLOWANCES_PATH = join(ROOT, "config/ci-ratchet-allowances.json");
const REPORT_PATH = join(ROOT, "artifacts/remote-control-route-reachability.json");
const LAZY_PAGES_PATH = join(ROOT, "client/src/lazyPages.ts");

const ACTION_PATTERNS = [
  /data-remote-control-action\s*=\s*["']([^"']+)["']/g,
  /setAttribute\(\s*["']data-remote-control-action["']\s*,\s*["']([^"']+)["']\s*\)/g,
];
const EDITABLE_PATTERNS = [
  /data-remote-control-editable\s*=\s*["']true["']/g,
  /setAttribute\(\s*["']data-remote-control-editable["']\s*,\s*["']true["']\s*\)/g,
];
const REGISTRY_RE = /REMOTE_CONTROL_ALLOWED_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/;
const EXPLICIT_SURFACE_RE = /data-remote-control-(?:action|editable)\s*=|setAttribute\(\s*["']data-remote-control-(?:action|editable)["']/;
const LANDMARK_SOURCE_RE = /<(?:nav|header)\b|role\s*=\s*["'](?:navigation|tablist|menu|toolbar)["']|(?:data-testid|data-command-menu|cmdk-root)[^\n>]{0,120}(?:sidebar|command|pagination|toolbar|tabs|topbar|header)/i;
const STABLE_CONTROL_SOURCE_RE = /<(?:a|button|Button|Link)\b[^>]{0,320}(?:href\s*=\s*["']\/|data-testid\s*=|aria-label\s*=|title\s*=|aria-controls\s*=|aria-expanded\s*=|aria-haspopup\s*=|role\s*=\s*["'](?:tab|menuitem)["'])/i;

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "build"].includes(e.name)) continue;
      await walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

async function scanCoverage(files) {
  const actions = new Map();
  const editableFiles = new Set();
  let editableUsages = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const relativePath = relative(ROOT, file).replaceAll("\\", "/");

    for (const pattern of ACTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const action = match[1].trim();
        if (!action) continue;
        if (!actions.has(action)) actions.set(action, new Set());
        actions.get(action).add(relativePath);
      }
    }

    for (const pattern of EDITABLE_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        editableUsages += matches.length;
        editableFiles.add(relativePath);
      }
    }
  }

  return { actions, editableUsages, editableFiles };
}

async function readRegistry() {
  const text = await readFile(REGISTRY_PATH, "utf8");
  const match = REGISTRY_RE.exec(text);
  if (!match) throw new Error("Could not parse REMOTE_CONTROL_ALLOWED_ACTIONS from registry");
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1].trim()).filter(Boolean);
  return { text, values };
}

function registrySource(values) {
  const entries = values.map((value) => `  "${value}",`).join("\n");
  return `/**\n * Generated \`data-remote-control-action\` registry — usable allowlist for remote mouse control.\n *\n * Every value here is actively used by a reviewed read-only or navigation-safe\n * control. The verifier keeps the registry exact: unregistered usages and stale\n * forward-registered values both fail CI so coverage cannot silently drift.\n */\nexport const REMOTE_CONTROL_ALLOWED_ACTIONS = [\n${entries}\n] as const;\n\nexport type RemoteControlAction = (typeof REMOTE_CONTROL_ALLOWED_ACTIONS)[number];\n\nexport const REMOTE_CONTROL_ACTION_SET = new Set<string>(REMOTE_CONTROL_ALLOWED_ACTIONS);\n\nexport function isRegisteredRemoteControlAction(action: string | null | undefined): boolean {\n  return typeof action === "string" && REMOTE_CONTROL_ACTION_SET.has(action);\n}\n\nexport function getRemoteControlAction(element: Element | null): string | null {\n  if (!element) return null;\n  const raw = element.getAttribute("data-remote-control-action");\n  if (raw == null) return null;\n  const trimmed = raw.trim();\n  return trimmed.length > 0 ? trimmed : null;\n}\n\nexport function describeRemoteControlActionRegistry(): string {\n  return REMOTE_CONTROL_ALLOWED_ACTIONS.join(", ");\n}\n`;
}

async function existingModulePath(specifier, fromFile) {
  if (!specifier || (!specifier.startsWith("@/") && !specifier.startsWith("."))) return null;
  const base = specifier.startsWith("@/")
    ? join(CLIENT_SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, join(base, "index.tsx"), join(base, "index.ts")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next extension
    }
  }
  return null;
}

async function lazyPageMap() {
  const text = await readFile(LAZY_PAGES_PATH, "utf8");
  const map = new Map();
  const pattern = /export const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>[\s\S]{0,180}?import\(["']([^"']+)["']\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const file = await existingModulePath(match[2], LAZY_PAGES_PATH);
    if (file) map.set(match[1], file);
  }
  return map;
}

async function directImportMap(file, text) {
  const map = new Map();
  const defaultImport = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  let match;
  while ((match = defaultImport.exec(text))) {
    const resolved = await existingModulePath(match[2], file);
    if (resolved) map.set(match[1], resolved);
  }
  return map;
}

function routeCandidates(file, text) {
  const routes = [];
  const componentRoutes = /<Route\b([^>]*?)\bpath\s*=\s*["']([^"']+)["']([^>]*)>/g;
  let match;
  while ((match = componentRoutes.exec(text))) {
    const opening = `${match[1]} ${match[3]}`;
    const tail = text.slice(componentRoutes.lastIndex, componentRoutes.lastIndex + 650);
    const attrComponent = /component\s*=\s*\{\s*([A-Za-z_$][\w$]*)/.exec(opening)?.[1] ?? null;
    const childComponent = /<([A-Z][A-Za-z0-9_$]*)\b/.exec(tail)?.[1] ?? null;
    const redirectOnly = /<Redirect\b/.test(tail.slice(0, 260)) && !attrComponent && !childComponent;
    routes.push({ path: match[2], component: attrComponent ?? childComponent, redirectOnly });
  }

  const gated = /\bG\(\s*["']([^"']+)["']\s*,\s*["'][^"']*["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  while ((match = gated.exec(text))) routes.push({ path: match[1], component: match[2], redirectOnly: false });
  return routes;
}

async function localImportGraph(entry, maxDepth = 2) {
  const visited = new Set();
  async function visit(file, depth) {
    if (!file || visited.has(file) || depth > maxDepth) return;
    visited.add(file);
    const text = await readFile(file, "utf8");
    const imports = /(?:from\s+|import\s*\()["']([^"']+)["']/g;
    let match;
    while ((match = imports.exec(text))) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("@/components/") && !specifier.startsWith("@/pages/")) continue;
      const child = await existingModulePath(specifier, file);
      if (child) await visit(child, depth + 1);
    }
  }
  await visit(entry, 0);
  return [...visited];
}

async function reachabilityEvidence(componentFile) {
  if (!componentFile) return null;
  const graph = await localImportGraph(componentFile);
  for (const file of graph) {
    const text = await readFile(file, "utf8");
    if (EXPLICIT_SURFACE_RE.test(text)) {
      return { kind: "explicit-annotation", file: relative(ROOT, file).replaceAll("\\", "/") };
    }
  }
  for (const file of graph) {
    const text = await readFile(file, "utf8");
    if (LANDMARK_SOURCE_RE.test(text) && STABLE_CONTROL_SOURCE_RE.test(text)) {
      return { kind: "semantic-landmark", file: relative(ROOT, file).replaceAll("\\", "/") };
    }
  }
  return null;
}

async function buildRouteReachabilityReport(files) {
  const lazy = await lazyPageMap();
  const entries = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".tsx"))) {
    const text = await readFile(file, "utf8");
    if (!text.includes("<Route") && !/\bG\(\s*["']\//.test(text)) continue;
    const imports = await directImportMap(file, text);
    for (const route of routeCandidates(file, text)) {
      const source = relative(ROOT, file).replaceAll("\\", "/");
      const key = `${source}::${route.path}`;
      let componentFile = route.component ? lazy.get(route.component) ?? imports.get(route.component) ?? null : null;
      const evidence = route.redirectOnly ? { kind: "redirect-only", file: source } : await reachabilityEvidence(componentFile);
      entries.push({
        key,
        route: route.path,
        source,
        component: route.component,
        componentFile: componentFile ? relative(ROOT, componentFile).replaceAll("\\", "/") : null,
        reachable: Boolean(evidence && evidence.kind !== "redirect-only"),
        evidence,
      });
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key) || String(a.component).localeCompare(String(b.component)));
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    unique.push(entry);
  }
  return unique;
}

async function writeReachabilityReport(routes) {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  const reachable = routes.filter((route) => route.reachable).length;
  const report = {
    formatVersion: 1,
    routeCount: routes.length,
    reachableCount: reachable,
    unreachableCount: routes.length - reachable,
    routes,
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function ratchetReachability(routes, writeBaseline) {
  const allowances = JSON.parse(await readFile(ALLOWANCES_PATH, "utf8"));
  const unreachable = routes.filter((route) => !route.reachable).map((route) => route.key).sort();
  if (writeBaseline) {
    allowances.remoteControlUnreachableRoutes = unreachable;
    await writeFile(ALLOWANCES_PATH, `${JSON.stringify(allowances, null, 2)}\n`, "utf8");
    console.log(`Wrote ${unreachable.length} reviewed unreachable routes to ${relative(ROOT, ALLOWANCES_PATH)}`);
    return { ok: true, added: [], stale: [] };
  }

  const reviewed = Array.isArray(allowances.remoteControlUnreachableRoutes)
    ? allowances.remoteControlUnreachableRoutes.filter((value) => typeof value === "string").sort()
    : [];
  const actualSet = new Set(unreachable);
  const reviewedSet = new Set(reviewed);
  const added = unreachable.filter((key) => !reviewedSet.has(key));
  const stale = reviewed.filter((key) => !actualSet.has(key));
  return { ok: added.length === 0 && stale.length === 0, added, stale };
}

async function main() {
  const writeRegistry = process.argv.includes("--write");
  const writeBaseline = process.argv.includes("--write-reachability-baseline");
  const files = await walk(CLIENT_SRC);
  const { actions: discovered, editableUsages, editableFiles } = await scanCoverage(files);
  const { values: registered } = await readRegistry();
  const registeredSet = new Set(registered);
  const discoveredSet = new Set(discovered.keys());

  if (writeRegistry) {
    const exact = [...discoveredSet].sort();
    await writeFile(REGISTRY_PATH, registrySource(exact), "utf8");
    console.log(`Wrote exact registry with ${exact.length} actions to ${REGISTRY_PATH}`);
  }

  let ok = true;
  const unregistered = [...discoveredSet].filter((action) => !registeredSet.has(action));
  const unused = [...registeredSet].filter((action) => !discoveredSet.has(action));

  if (!writeRegistry && unregistered.length) {
    ok = false;
    console.error(`\nUnregistered data-remote-control-action values found (${unregistered.length}):`);
    for (const action of unregistered.sort()) {
      console.error(`  - "${action}" in:`);
      for (const file of [...(discovered.get(action) ?? [])].sort()) console.error(`      ${file}`);
    }
  }

  if (!writeRegistry && unused.length) {
    ok = false;
    console.error(`\nRegistered but unused actions found (${unused.length}):`);
    for (const action of unused.sort()) console.error(`  - "${action}"`);
  }

  if (editableUsages === 0) {
    ok = false;
    console.error("\nNo explicit data-remote-control-editable=\"true\" coverage was discovered.");
  }

  const routes = await buildRouteReachabilityReport(files);
  const report = await writeReachabilityReport(routes);
  const ratchet = await ratchetReachability(routes, writeBaseline);
  if (!ratchet.ok) {
    ok = false;
    if (ratchet.added.length) {
      console.error(`\nNew unreachable routes require review (${ratchet.added.length}):`);
      for (const key of ratchet.added) console.error(`  - ${key}`);
    }
    if (ratchet.stale.length) {
      console.error(`\nStale unreachable-route allowances must be removed (${ratchet.stale.length}):`);
      for (const key of ratchet.stale) console.error(`  - ${key}`);
    }
  }

  if (!ok) {
    console.error("\nRun node scripts/generate-remote-control-action-registry.mjs --write after reviewing new safe actions; use --write-reachability-baseline only for an explicitly reviewed route baseline.\n");
    process.exit(1);
  }

  console.log(
    `remote-control coverage OK: ${writeRegistry ? discoveredSet.size : registered.length} actions, ${editableUsages} editable annotations across ${editableFiles.size} files; route reachability ${report.reachableCount}/${report.routeCount} with ${report.unreachableCount} reviewed unreachable routes`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
'''

ROUTE_TEST = r'''import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("remote-control per-route reachability ratchet", () => {
  it("verifies every literal client route against the exact reviewed allowance", () => {
    execFileSync(process.execPath, ["scripts/generate-remote-control-action-registry.mjs"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    const report = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "artifacts/remote-control-route-reachability.json"), "utf8")
    ) as {
      routeCount: number;
      reachableCount: number;
      unreachableCount: number;
      routes: Array<{ key: string; reachable: boolean; evidence: unknown }>;
    };
    const allowances = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "config/ci-ratchet-allowances.json"), "utf8")
    ) as { remoteControlUnreachableRoutes: string[] };

    expect(report.routeCount).toBeGreaterThan(100);
    expect(report.reachableCount + report.unreachableCount).toBe(report.routeCount);
    expect(new Set(report.routes.map((route) => route.key)).size).toBe(report.routeCount);
    expect(report.routes.filter((route) => route.reachable).every((route) => route.evidence)).toBe(true);
    expect(report.routes.filter((route) => !route.reachable).map((route) => route.key).sort()).toEqual(
      [...allowances.remoteControlUnreachableRoutes].sort()
    );
  });
});
'''

CAPTURE_VIEWPORT_TEST = r'''// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildViewportMetadata } from "./screen-feed-capture-engine";

describe("screen feed viewport metadata", () => {
  afterEach(() => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("preserves finite negative RTL scrollX while keeping scrollY non-negative", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: -240.4 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: -20 });
    const viewport = buildViewportMetadata();
    expect(viewport.scrollX).toBe(-240);
    expect(viewport.scrollY).toBe(0);
  });
});
'''

write("client/src/hooks/remote-control-surface-coverage.ts", SURFACE)
write("client/src/hooks/remote-control-surface-coverage.test.ts", SURFACE_TEST)
write("shared/remoteSupportTransport.ts", TRANSPORT)
write("tests/remote-support-binary-transport.test.ts", TRANSPORT_TEST)
write("scripts/generate-remote-control-action-registry.mjs", GENERATOR)
write("tests/remote-control-route-reachability.test.ts", ROUTE_TEST)
write("client/src/hooks/screen-feed-capture-engine.viewport.test.ts", CAPTURE_VIEWPORT_TEST)

replace_one(
    "client/src/hooks/screen-feed-capture-engine.ts",
    'import { sendScreenFeedBinaryFrame } from "@/lib/screen-feed-binary-transport";',
    'import { sendScreenFeedBinaryFrame } from "@/lib/screen-feed-binary-transport";\nimport { REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION } from "@shared/remoteSupportTransport";',
)
replace_one(
    "client/src/hooks/screen-feed-capture-engine.ts",
    "function buildViewportMetadata() {",
    "export function buildViewportMetadata() {",
)
replace_one(
    "client/src/hooks/screen-feed-capture-engine.ts",
    "scrollX: Math.max(0, Math.round(window.scrollX)),",
    "scrollX: Number.isFinite(window.scrollX) ? Math.round(window.scrollX) : 0,",
)
replace_one(
    "client/src/hooks/screen-feed-capture-engine.ts",
    '        version: 1,\n        tabId: getRemoteSupportTabId(),',
    '        version: REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION,\n        tabId: getRemoteSupportTabId(),',
)
replace_one(
    "server/services/screenFeedService.ts",
    "const scrollX = boundedNumber(viewport.scrollX, 0, MAX_VIEWPORT_DIMENSION * 10);",
    "const scrollX = boundedNumber(viewport.scrollX, -MAX_VIEWPORT_DIMENSION * 10, MAX_VIEWPORT_DIMENSION * 10);",
)
replace_one(
    "server/services/remoteControlCommandService.ts",
    "const scrollX = boundedFrameNumber(viewport.scrollX, 0, MAX_FRAME_VIEWPORT_SCROLL);",
    "const scrollX = boundedFrameNumber(viewport.scrollX, -MAX_FRAME_VIEWPORT_SCROLL, MAX_FRAME_VIEWPORT_SCROLL);",
)

replace_one(
    "tests/screen-feed-viewing-metadata.test.ts",
    '    expect(sanitizeScreenFeedViewport({ ...valid, scrollX: -1 })).toBeUndefined();',
    '    expect(sanitizeScreenFeedViewport({ ...valid, scrollX: -200001 })).toBeUndefined();',
)
replace_one(
    "tests/screen-feed-viewing-metadata.test.ts",
    '    expect(sanitizeScreenFeedViewport(null)).toBeUndefined();',
    '    expect(\n      sanitizeScreenFeedViewport({ ...valid, scrollX: -120 })?.scrollX\n    ).toBe(-120);\n    expect(sanitizeScreenFeedViewport(null)).toBeUndefined();',
)

replace_one(
    "tests/remote-control-command-service.test.ts",
    '    const frameViewport = { width: 1280, height: 720, scrollX: 0, scrollY: 240, visualScale: 1 };',
    '    const frameViewport = { width: 1280, height: 720, scrollX: -120, scrollY: 240, visualScale: 1 };',
)
replace_one(
    "tests/remote-control-command-service.test.ts",
    '    expect(sanitizeRemoteMouseFrameViewport(null)).toBeUndefined();',
    '    expect(\n      sanitizeRemoteMouseFrameViewport({ width: 1280, height: 720, scrollX: -240, scrollY: 0, visualScale: 1 })\n    ).toEqual({ width: 1280, height: 720, scrollX: -240, scrollY: 0, visualScale: 1 });\n    expect(\n      sanitizeRemoteMouseFrameViewport({ width: 1280, height: 720, scrollX: -200001, scrollY: 0, visualScale: 1 })\n    ).toBeUndefined();\n    expect(sanitizeRemoteMouseFrameViewport(null)).toBeUndefined();',
)

replace_one(
    "client/src/hooks/remote-mouse-control-policy.test.ts",
    '    // A resize or zoom no longer invalidates the frame: the point is remapped\n',
    '    // RTL Chromium can report negative page scrollX. Preserve the sign when\n    // mapping the captured document point back into the live viewport.\n    Object.defineProperty(window, "scrollX", { configurable: true, value: -120 });\n    const rtlFrameViewport = { ...frameViewport, scrollX: -200 };\n    expect(applyRemoteMouseCommand(command("click", { frameViewport: rtlFrameViewport }))).toMatchObject({\n      status: "executed",\n      clientX: 420,\n      clientY: 60,\n    });\n\n    // A resize or zoom no longer invalidates the frame: the point is remapped\n',
)
replace_one(
    "client/src/hooks/remote-mouse-control-policy.test.ts",
    "    expect(viewClick).toHaveBeenCalledTimes(5);",
    "    expect(viewClick).toHaveBeenCalledTimes(6);",
)

# Keep the new exact ratchet key present before the baseline writer runs.
allowances_path = ROOT / "config/ci-ratchet-allowances.json"
allowances = json.loads(allowances_path.read_text(encoding="utf-8"))
allowances.setdefault("remoteControlUnreachableRoutes", [])
allowances_path.write_text(json.dumps(allowances, indent=2) + "\n", encoding="utf-8")

print("Phase 18 source patch applied")
