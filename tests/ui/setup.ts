import "@testing-library/jest-dom";

// jsdom does not implement ResizeObserver — stub it so components using it don't crash
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix dropdown/dialog primitives use pointer-capture and scroll APIs that
// jsdom does not provide. These no-op shims model the browser surface without
// changing component behaviour under test.
// Guarded so a pure-logic file can opt into `@vitest-environment node`.
if (typeof HTMLElement !== "undefined") {
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
}

// jsdom 30.1 implements "focus fixup": once the focused element is removed
// (e.g. a menu unmounting in cleanup), the Document itself becomes the focused
// area, and the next element.focus() dispatches `blur` at `window` with that
// element as relatedTarget. Browsers never fire a window blur for focus moving
// within the page, and Radix menus close on window blur, so a menu opened after
// any focused node was removed would close in the same commit. Swallow only that
// in-document case; a real window blur (relatedTarget null) still propagates.
if (typeof window !== "undefined" && typeof Node !== "undefined") {
  window.addEventListener(
    "blur",
    (event) => {
      const next = (event as FocusEvent).relatedTarget;
      // The target is the Window (not a Node); under vitest `window` is a proxy, so
      // an identity check against it would never match.
      if (!(event.target instanceof Node) && next instanceof Node && document.contains(next)) {
        event.stopImmediatePropagation();
      }
    },
    { capture: true }
  );
}
