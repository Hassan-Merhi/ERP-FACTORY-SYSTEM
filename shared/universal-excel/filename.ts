/** Strict filename validation for report and attachment downloads. */
export function validateUniversalExcelFilename(filename: string): string {
  if (!filename || filename !== filename.trim() ||
      filename.length > 180 || !/\.xlsx$/i.test(filename) ||
      Array.from(filename).some(char => char.charCodeAt(0) < 32 || "\\/<>\"|?*:".includes(char)) ||
      filename === "." || filename === ".." || filename.startsWith(".")) {
    throw new Error("Invalid Excel export filename");
  }
  return filename;
}
