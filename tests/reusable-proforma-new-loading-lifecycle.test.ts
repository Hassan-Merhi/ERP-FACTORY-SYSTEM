import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const factoryModelPath = "client/src/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel.ts";
const erpModelPath = "client/src/pages/containerloadingscan/useContainerLoadingScanModel.ts";

describe("reusable proforma new-loading lifecycle", () => {
  it.each([factoryModelPath, erpModelPath])(
    "%s resets stale order state when the orderId query param is removed",
    (path) => {
      const source = read(path);
      expect(source).toContain("useSearch");
      expect(source).toContain("if (!resumeOrderId)");
      expect(source).toContain("setOrderId(null)");
      expect(source).toContain("setIsResuming(false)");
    }
  );

  it.each([factoryModelPath, erpModelPath])(
    "%s canonicalizes every newly-created loading to its own orderId URL",
    (path) => {
      const source = read(path);
      expect(source).toContain("navigate(`/factory/sales/loading/new?orderId=${data.id}`)");
      expect(source).toContain("setOrderId(data.id)");
    }
  );

  it.each([factoryModelPath, erpModelPath])(
    "%s never blocks a fresh loading because sibling loadings consumed aggregate proforma quantity",
    (path) => {
      const source = read(path);
      expect(source).not.toContain('title: "Proforma fully consumed"');
      expect(source).not.toContain('description: "No remaining quantity is available for a new loading."');
    }
  );

  it.each([factoryModelPath, erpModelPath])("%s rejects a capacity response scoped to a different loading", (path) => {
    const source = read(path);
    expect(source).toContain("snapshot.currentOrderId !== orderId");
    expect(source).toContain("Proforma capacity returned for the wrong loading order");
  });

  it("preserves the new loading note when the factory warning offers a separate loading", () => {
    const source = read(factoryModelPath);
    const start = source.indexOf("const startNewLoadingAnyway");
    const end = source.indexOf("const downloadTemplate", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("containerNotes: loadingNote.trim() || undefined");
  });
});
