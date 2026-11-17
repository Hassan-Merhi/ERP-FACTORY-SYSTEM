import { downloadBlob } from "./downloadBlob";

export type ExportFileExtension = "xlsx" | "csv" | "pdf" | "json" | "zip" | "txt";

export interface ExportFileNameOptions {
  /** Start of the reported period (`yyyy-MM-dd` or a Date). */
  from?: string | Date | null;
  /** End of the reported period (`yyyy-MM-dd` or a Date). */
  to?: string | Date | null;
  /** Stamp used when no period is given. Defaults to today. `false` omits it. */
  date?: string | Date | false;
}

function localDateStamp(value: string | Date): string {
  if (typeof value === "string") {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
    if (match) return match[0];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? exportFileSlug(value) : localDateStamp(parsed);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `Daily Production (Line 2)` → `daily-production-line-2`. Keeps non-Latin letters. */
export function exportFileSlug(subject: string): string {
  const slug = subject
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "export";
}

/**
 * The one file-naming rule for exports in every company type:
 * `subject-in-kebab-case_YYYY-MM-DD.ext`, or `subject_FROM_TO.ext` when the
 * export covers a period. See docs/ui-unification/plan.md.
 */
export function exportFileName(
  subject: string,
  extension: ExportFileExtension,
  options: ExportFileNameOptions = {}
): string {
  const parts = [exportFileSlug(subject)];
  if (options.from || options.to) {
    if (options.from) parts.push(localDateStamp(options.from));
    if (options.to && (!options.from || localDateStamp(options.to) !== localDateStamp(options.from))) {
      parts.push(localDateStamp(options.to));
    }
  } else if (options.date !== false) {
    parts.push(localDateStamp(options.date ?? new Date()));
  }
  return `${parts.join("_")}.${extension}`;
}

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain filename.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const value = plain ? (plain[2] ?? plain[1]).trim() : "";
  return value || null;
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        const message = parsed.message ?? parsed.error;
        if (typeof message === "string" && message.trim()) return message;
      } catch {
        if (text.length < 300 && !text.trimStart().startsWith("<")) return text;
      }
    }
  } catch {
    // Use the status below.
  }
  return `Download failed (${response.status})`;
}

export interface DownloadFromUrlOptions {
  /** Used when the server sends no Content-Disposition filename. */
  fileName: string;
  method?: "GET" | "POST";
  /** JSON body for POST exports. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Prefer `fileName` even when the server names the file. */
  preferLocalFileName?: boolean;
}

/**
 * Download a server-generated export (Excel, CSV, PDF…) as a file.
 *
 * Use this instead of `window.open(url)` / `location.assign(url)` / a bare
 * anchor: those give the user a blank tab or a raw JSON error page when the
 * server refuses, and they cannot show a busy state. This rejects with the
 * server's message so the caller can show a failure toast.
 */
export async function downloadFromUrl(url: string, options: DownloadFromUrlOptions): Promise<string> {
  const { fileName, method = "GET", body, headers, signal, preferLocalFileName = false } = options;
  const response = await fetch(url, {
    method,
    credentials: "include",
    signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseErrorMessage(response));
  const blob = await response.blob();
  const serverName = fileNameFromContentDisposition(response.headers.get("Content-Disposition"));
  const resolvedName = preferLocalFileName ? fileName : (serverName ?? fileName);
  downloadBlob(blob, resolvedName);
  return resolvedName;
}
