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
