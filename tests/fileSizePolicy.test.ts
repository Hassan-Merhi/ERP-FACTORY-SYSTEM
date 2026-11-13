import { describe, expect, it } from "vitest";
import {
  FILE_SIZE_LIMITS,
  canUsePrivilegedSpreadsheetLimit,
  generalUploadLimitBytes,
  spreadsheetImportLimitBytes,
  sizeLimitLabel,
} from "../shared/fileSizePolicy";

describe("shared upload size policy", () => {
  it("grants 100 MB imports only to signed-in privileged roles", () => {
    expect(spreadsheetImportLimitBytes("User")).toBe(50 * 1024 * 1024);
    expect(spreadsheetImportLimitBytes("Admin")).toBe(100 * 1024 * 1024);
    expect(spreadsheetImportLimitBytes("Owner")).toBe(100 * 1024 * 1024);
    expect(spreadsheetImportLimitBytes("Developer")).toBe(100 * 1024 * 1024);
    expect(spreadsheetImportLimitBytes(undefined)).toBe(50 * 1024 * 1024);
    expect(spreadsheetImportLimitBytes("admin")).toBe(50 * 1024 * 1024);
    expect(canUsePrivilegedSpreadsheetLimit("View Only")).toBe(false);
  });

  it("caps general uploads and images independently of spreadsheets", () => {
    expect(generalUploadLimitBytes("stock.png", "image/png")).toBe(FILE_SIZE_LIMITS.image);
    expect(generalUploadLimitBytes("invoice.pdf", "application/pdf")).toBe(FILE_SIZE_LIMITS.pdf);
    expect(generalUploadLimitBytes("document.docx", "application/octet-stream")).toBe(FILE_SIZE_LIMITS.general);
    expect(sizeLimitLabel(FILE_SIZE_LIMITS.spreadsheetExportTarget)).toBe("100 MB");
  });
});
