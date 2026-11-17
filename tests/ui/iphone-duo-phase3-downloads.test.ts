import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB_DOWNLOAD_GRACE_MS, downloadBlob } from "@/lib/downloadBlob";
import { downloadFromUrl } from "@/lib/exportFile";

let click: ReturnType<typeof vi.spyOn>;
let create: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;
let clickedAnchor: HTMLAnchorElement | null;
let originalCreate: PropertyDescriptor | undefined;
let originalRevoke: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  clickedAnchor = null;
  originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  create = vi.fn(() => "blob:test-export");
  revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchor = this;
    expect(document.body.contains(this)).toBe(true);
  });
});

afterEach(() => {
  click.mockRestore();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("iOS Safari file-download lifecycle", () => {
  it("uses a mounted native download link and preserves the requested filename", () => {
    const blob = new Blob(["sample"], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, "factory-production.csv");
    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(clickedAnchor?.download).toBe("factory-production.csv");
    expect(clickedAnchor?.href).toBe("blob:test-export");
    expect(clickedAnchor?.rel).toBe("noopener");
    expect(document.body.contains(clickedAnchor)).toBe(false);
  });

  it("does not revoke the file URL before Safari can consume the download", () => {
    downloadBlob(new Blob(["xlsx"]), "production.xlsx");
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BLOB_DOWNLOAD_GRACE_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test-export");
  });

  it("removes the anchor and schedules cleanup even when the browser rejects the click", () => {
    click.mockImplementation(() => { throw new Error("blocked by browser"); });
    expect(() => downloadBlob(new Blob(["report"]), "report.csv")).toThrow("blocked by browser");
    expect(document.querySelector('a[download="report.csv"]')).toBeNull();
    vi.advanceTimersByTime(BLOB_DOWNLOAD_GRACE_MS);
    expect(revoke).toHaveBeenCalledWith("blob:test-export");
  });
});

describe("Excel export download validation", () => {
  it("rejects an empty success response instead of saving a 0-byte XLSX", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob([]), { status: 200 })));
    await expect(downloadFromUrl("/api/accounts/statement/export-excel", {
      fileName: "KOLWEZI_CASH_Statement.xlsx",
    })).rejects.toThrow("0 bytes");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a 200 HTML error page mislabeled as an XLSX download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>error</html>", { status: 200 })));
    await expect(downloadFromUrl("/api/accounts/statement/export-excel", {
      fileName: "KOLWEZI_CASH_Statement.xlsx",
    })).rejects.toThrow("invalid Excel file");
    expect(create).not.toHaveBeenCalled();
  });

  it("still downloads a nonempty ZIP-signature XLSX response", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));
    await expect(downloadFromUrl("/api/accounts/statement/export-excel", {
      fileName: "KOLWEZI_CASH_Statement.xlsx",
    })).resolves.toBe("KOLWEZI_CASH_Statement.xlsx");
    expect(create).toHaveBeenCalledTimes(1);
    expect(clickedAnchor?.download).toBe("KOLWEZI_CASH_Statement.xlsx");
  });
});
