/**
 * Central upload sizing in binary MiB. UI checks are advisory; backend is authoritative.
 */
export const FILE_SIZE_LIMITS = {
  spreadsheetImport: 50 * 1024 * 1024,
  privilegedSpreadsheetImport: 100 * 1024 * 1024,
  spreadsheetExportTarget: 100 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  general: 25 * 1024 * 1024,
} as const;

export function canUsePrivilegedSpreadsheetLimit(role: string | null | undefined): boolean {
  return role === "Admin" || role === "Owner" || role === "Developer";
}

export function spreadsheetImportLimitBytes(role?: string | null): number {
  return canUsePrivilegedSpreadsheetLimit(role)
    ? FILE_SIZE_LIMITS.privilegedSpreadsheetImport
    : FILE_SIZE_LIMITS.spreadsheetImport;
}

export function generalUploadLimitBytes(filename: string, mimeType = ""): number {
  if (/^image\//i.test(mimeType) || /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(filename)) {
    return FILE_SIZE_LIMITS.image;
  }
  return FILE_SIZE_LIMITS.general;
}

export function sizeLimitLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
