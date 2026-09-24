import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDocumentAppShell } from "./use-document-app-shell";

afterEach(() => {
  delete document.documentElement.dataset.appShell;
});

describe("useDocumentAppShell", () => {
  it("marks the document only while the shell is mounted", () => {
    const { unmount } = renderHook(() => useDocumentAppShell("erp"));
    expect(document.documentElement.dataset.appShell).toBe("erp");

    unmount();
    expect(document.documentElement.dataset.appShell).toBeUndefined();
  });

  it("leaves a newer shell's marker in place", () => {
    const erp = renderHook(() => useDocumentAppShell("erp"));
    renderHook(() => useDocumentAppShell("factory"));

    erp.unmount();
    expect(document.documentElement.dataset.appShell).toBe("factory");
  });
});
