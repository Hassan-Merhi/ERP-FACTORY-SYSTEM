/**
 * In-page helpers for the training recorder. Every exported function here is
 * serialised by Puppeteer and executed inside the real application page, so
 * each one must be self-contained (no closures over module state).
 */

/** Overlay layers the app opens on top of a screen: menus, dropdown lists, dialogs, sheets. */
export const LAYER_SELECTOR = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper], [role=menu], [role=listbox], [cmdk-root], [data-state=open][role=menu], [role=alertdialog]";

/**
 * Enumerate the visible controls and section headings of the current screen.
 * With `layerOnly`, only the controls inside the open overlay layer (menu,
 * dropdown list, dialog) are returned; they are the "hidden" controls that are
 * invisible until something is clicked.
 */
export function enumerateScreen(options) {
  const LAYER = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper], [role=menu], [role=listbox], [cmdk-root], [data-state=open][role=menu], [role=alertdialog]";
  const CONTROLS = "button, a[href], [role=tab], [role=button], input, select, textarea, [role=combobox], [role=switch], [role=checkbox], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], summary";
  const layerOnly = Boolean(options && options.layerOnly);
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  // innerText keeps the visual line breaks between child elements, so a button
  // rendered as "Loading" + badge "0" yields "Loading" / "0" instead of "Loading0".
  const textLines = (el) => String(el.innerText || el.textContent || "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = (el) => {
    const explicit = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (explicit) return { label: explicit.replace(/\s+/g, " ").trim().slice(0, 90), description: "", count: "" };
    const lines = textLines(el);
    let label = lines[0] || "";
    let count = "";
    const rest = lines.slice(1);
    if (rest.length && /^\(?\d+\)?$/.test(rest[0])) count = rest.shift().replace(/[()]/g, "");
    const glued = label.match(/^(.*\S)\s*\((\d+)\)$/) || label.match(/^([A-Za-z][A-Za-z &/-]*[A-Za-z])(\d+)$/);
    if (glued) { label = glued[1].trim(); count = glued[2]; }
    return { label: label.slice(0, 90), description: rest.join(" ").slice(0, 160), count };
  };
  const region = (el) => el.closest(LAYER) ? "layer"
    : el.closest("[data-sidebar=sidebar]") ? "sidebar"
    : el.closest("#main-content") ? "main"
    : el.closest("header") ? "header" : "floating";
  const rows = [];
  const seen = new Set();
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const { label, description, count } = text(el);
    if (!label && !el.getAttribute("data-testid")) return;
    if (/^skip to main content$/i.test(label)) return;
    const role = el.getAttribute("role") || "";
    const siblings = kind === "control" && role !== "tab" && role !== "option" && !/^tab-/.test(el.getAttribute("data-testid") || "") && el.parentElement
      ? Array.from(el.parentElement.children).filter((child) => child !== el && /^(BUTTON|A)$/.test(child.tagName) && visible(child)).map((child) => text(child).label).filter(Boolean).slice(0, 6)
      : [];
    rows.push({
      kind, region: region(el), tag: el.tagName.toLowerCase(), role,
      type: el.getAttribute("type") || "",
      label, description, count, testid: el.getAttribute("data-testid") || "",
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") === "page" || el.getAttribute("data-active") === "true" || el.getAttribute("data-state") === "active",
      pressed: el.getAttribute("aria-pressed") === "true" || el.getAttribute("data-state") === "on" || el.getAttribute("aria-checked") === "true",
      expanded: el.hasAttribute("aria-expanded") ? el.getAttribute("aria-expanded") : null,
      haspopup: el.getAttribute("aria-haspopup") || "",
      group: siblings.length >= 2 ? siblings : [],
      value: el.tagName === "SELECT" ? (el.selectedOptions?.[0]?.textContent || "").trim() : "",
      placeholder: el.getAttribute("placeholder") || "",
      href: el.getAttribute("href") || "",
      level: kind === "heading" ? el.tagName.toLowerCase() : "",
    });
  };
  if (layerOnly) {
    const layers = Array.from(document.querySelectorAll(LAYER)).filter(visible);
    const layer = layers[layers.length - 1];
    if (!layer) return { rows: [], heading: "", subtitle: "", layerType: "" };
    Array.from(layer.querySelectorAll("h2, h3, " + CONTROLS)).filter(visible).forEach((el) => push(el, /^H[23]$/.test(el.tagName) ? "heading" : "control"));
    const layerType = layer.matches("[role=dialog], [role=alertdialog]") ? "dialog"
      : layer.matches("[role=menu], [data-state=open][role=menu]") || layer.querySelector("[role=menu]") ? "menu"
      : layer.matches("[role=listbox], [cmdk-root]") || layer.querySelector("[role=listbox], [cmdk-root]") ? "list" : "panel";
    const title = layer.querySelector("h1, h2, h3, [id$=title]");
    return { rows, heading: title ? title.textContent.replace(/\s+/g, " ").trim() : "", subtitle: "", layerType };
  }
  const header = Array.from(document.querySelectorAll("header " + CONTROLS.split(", ").join(", header "))).filter((el) => !el.closest("#main-content") && !el.closest("[data-sidebar=sidebar]") && visible(el) && region(el) !== "layer");
  header.forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll("[data-sidebar=sidebar] " + CONTROLS.split(", ").join(", [data-sidebar=sidebar] "))).filter((el) => visible(el) && region(el) !== "layer").forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll(CONTROLS)).filter((el) => visible(el) && region(el) === "floating").forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll("#main-content h2, #main-content h3, " + CONTROLS.split(", ").map((s) => "#main-content " + s).join(", "))).filter((el) => visible(el) && region(el) !== "layer").forEach((el) => push(el, /^H[23]$/.test(el.tagName) ? "heading" : "control"));
  const h1 = document.querySelector("#main-content h1");
  const subtitle = h1?.parentElement?.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() || "";
  return { rows, heading: h1?.textContent?.replace(/\s+/g, " ").trim() || document.title, subtitle, layerType: "" };
}

/** Is an overlay layer (menu, list, dialog) open right now, and of what type? */
export function openLayerType() {
  const LAYER = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper], [role=menu], [role=listbox], [cmdk-root], [data-state=open][role=menu], [role=alertdialog]";
  const layers = Array.from(document.querySelectorAll(LAYER)).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  const layer = layers[layers.length - 1];
  if (!layer) return "";
  if (layer.matches("[role=dialog], [role=alertdialog]")) return "dialog";
  if (layer.matches("[role=menu], [data-state=open][role=menu]") || layer.querySelector("[role=menu]")) return "menu";
  if (layer.matches("[role=listbox], [cmdk-root]") || layer.querySelector("[role=listbox], [cmdk-root]")) return "list";
  return "panel";
}

/** Find the element described by a segment and scroll it into view. */
export function locateAndScroll(segment) {
  const LAYER = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper], [role=menu], [role=listbox], [cmdk-root], [data-state=open][role=menu], [role=alertdialog]";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const text = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const inLayer = (el) => Boolean(el.closest(LAYER));
  let el = null;
  if (segment.testid) {
    const matches = Array.from(document.querySelectorAll('[data-testid="' + segment.testid.replace(/"/g, '\\"') + '"]')).filter((candidate) => visible(candidate) && (segment.region === "layer") === inLayer(candidate));
    el = matches[0] || null;
  }
  if (!el && segment.label) {
    const scope = segment.region === "layer" ? LAYER.split(", ").map((s) => s + " ").join(", ") : segment.region === "sidebar" ? "[data-sidebar=sidebar] " : segment.region === "main" ? "#main-content " : "";
    const unit = segment.kind === "heading" ? segment.level : (segment.tag || "*");
    const selector = scope.includes(", ") ? scope.split(", ").map((prefix) => prefix + unit).join(", ") : scope + unit;
    el = Array.from(document.querySelectorAll(selector)).find((candidate) => visible(candidate) && (segment.region === "layer") === inLayer(candidate) && text(candidate).startsWith(segment.label.slice(0, 40))) || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Draw the highlight ring, callout, caption bar and click ripple for the
 * current sentence. The mouse pointer itself is NOT drawn here: it is
 * composited by FFmpeg at the full output frame rate so it glides smoothly.
 */
export function paintOverlay({ rect, title, text, index, total, pulse, click }) {
  let layer = document.getElementById("training-recording-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "training-recording-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:system-ui,Segoe UI,sans-serif";
    layer.innerHTML = '<div id="trl-ring"></div><div id="trl-chip"></div><div id="trl-caption"></div><div id="trl-step"></div><div id="trl-click"></div>';
    document.body.appendChild(layer);
  }
  const ring = layer.querySelector("#trl-ring");
  const chip = layer.querySelector("#trl-chip");
  const caption = layer.querySelector("#trl-caption");
  const step = layer.querySelector("#trl-step");
  const ripple = layer.querySelector("#trl-click");
  if (click) {
    ripple.style.cssText = "position:fixed;left:" + (click.x - 18) + "px;top:" + (click.y - 18) + "px;width:36px;height:36px;border-radius:50%;border:3px solid #ff7a00;background:rgba(255,122,0,.25)";
  } else {
    ripple.style.cssText = "display:none";
  }
  if (rect) {
    const pad = 6;
    const left = Math.max(0, rect.x - pad);
    const top = Math.max(0, rect.y - pad);
    const width = Math.min(innerWidth - left, rect.width + pad * 2);
    const height = Math.min(innerHeight - top, rect.height + pad * 2);
    ring.style.cssText = "position:fixed;left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height +
      "px;border:" + (pulse ? 4 : 3) + "px solid #ff7a00;border-radius:10px;box-shadow:0 0 0 " + (pulse ? 6 : 4) +
      "px rgba(255,122,0,.28),0 0 24px rgba(255,122,0,.5)";
    const chipTop = top > 44 ? top - 38 : top + height + 8;
    chip.style.cssText = "position:fixed;left:" + left + "px;top:" + chipTop + "px;background:#ff7a00;color:#111;font:700 15px/1 system-ui;padding:8px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3);white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis";
    chip.textContent = title;
  } else {
    ring.style.cssText = "display:none";
    chip.style.cssText = "display:none";
  }
  caption.style.cssText = "position:fixed;left:24px;right:24px;bottom:20px;margin:0 auto;max-width:1100px;background:rgba(9,20,42,.94);color:#fff;border-radius:14px;padding:14px 20px;font:600 19px/1.3 system-ui;box-shadow:0 8px 32px rgba(0,0,0,.4)";
  caption.textContent = text;
  step.style.cssText = "position:fixed;right:24px;top:72px;background:rgba(9,20,42,.9);color:#fff;border-radius:999px;padding:6px 14px;font:600 13px system-ui";
  step.textContent = "Explaining " + index + " of " + total;
}

/** Render the pointer image used by the FFmpeg cursor overlay. */
export const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">' +
  '<path d="M5 3l14 8.5-6.2 1.3 3.6 6.4-2.6 1.4-3.6-6.4L5 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
