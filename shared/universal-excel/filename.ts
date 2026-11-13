/** Strict filename validation for report and attachment downloads. */
export function validateUniversalExcelFilename(filename: string): string {
  if (!filename || filename !== filename.trim() ||
      filename.length > 180 || !/\.xlsx$/i.test(filename) ||
      /[\\/<>"|?*:\u0000-\u001F]/.test(filename) ||
      filename === "." || filename === ".." || filename.startsWith(".")) {
    throw new Error("Invalid Excel export filename");
  }
  return filename;
}
