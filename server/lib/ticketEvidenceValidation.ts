export const MAX_TICKET_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export type TicketEvidenceMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export function sniffTicketEvidence(bytes: Buffer): TicketEvidenceMime | null {
  if (bytes.length < 12 || bytes.length > MAX_TICKET_ATTACHMENT_BYTES) return null;
  if (
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  )
    return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}
/** C0 control characters and DEL; stripped from names that reach headers and disks. */
function isControlCharacter(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export function safeTicketFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "attachment";
  const cleaned = Array.from(base, (ch) => (isControlCharacter(ch) || ch === '"' || ch === "\\" ? "_" : ch)).join("");
  return cleaned.slice(0, 160) || "attachment";
}
