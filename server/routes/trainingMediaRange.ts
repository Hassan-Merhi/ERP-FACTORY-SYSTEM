/**
 * Byte-range handling for authenticated training-video playback. Pure helpers,
 * kept apart from the route so they can be tested without a database.
 */
import { Transform } from "node:stream";

export interface ByteRange {
  /** Header forwarded to storage, e.g. "bytes=0-1" or "bytes=-500". */
  header: string;
  start?: number;
  end?: number;
  suffix?: number;
}

/** Single byte range only: "bytes=a-b", "bytes=a-" or "bytes=-n". */
export function parseByteRange(value: string): ByteRange | null {
  if (value.length > 80) return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { header: "bytes=-" + suffix, suffix } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (end !== undefined && end < start) return null;
  return { header: "bytes=" + start + "-" + (end ?? ""), start, end };
}

export interface MediaResponsePlan {
  status: 200 | 206;
  length: number;
  contentRange?: string;
  /** Bytes of the upstream body to drop before sending. */
  skip: number;
  /** Whether the upstream body may run past `length` and must be cut. */
  trim: boolean;
}

/**
 * Apple's media stack (Safari on iPhone, iPad and Mac) plays only when every
 * range reply carries the exact Content-Range and Content-Length of the bytes
 * it asked for. Work those out from the storage reply instead of trusting it
 * to have honoured the range, and refuse anything inconsistent.
 */
export function planMediaResponse(
  range: ByteRange | null,
  upstreamStatus: number,
  headers: Headers
): MediaResponsePlan | null {
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("content-range") || "");
  const upstreamLength = Number(headers.get("content-length"));
  let total: number;
  let bodyStart: number;
  if (upstreamStatus === 206 && contentRange) {
    total = Number(contentRange[3]);
    bodyStart = Number(contentRange[1]);
  } else if (upstreamStatus === 200 && Number.isSafeInteger(upstreamLength) && upstreamLength > 0) {
    total = upstreamLength;
    bodyStart = 0;
  } else {
    return null;
  }
  if (!range) {
    if (upstreamStatus !== 200) return null;
    return { status: 200, length: total, skip: 0, trim: false };
  }
  const start = range.suffix !== undefined ? Math.max(0, total - range.suffix) : (range.start ?? 0);
  const end = Math.min(total - 1, range.end ?? total - 1);
  if (start > end || start < bodyStart) return null;
  const bodyEnd = upstreamStatus === 206 && contentRange ? Number(contentRange[2]) : total - 1;
  if (bodyEnd < end) return null;
  return {
    status: 206,
    length: end - start + 1,
    contentRange: "bytes " + start + "-" + end + "/" + total,
    skip: start - bodyStart,
    trim: bodyEnd > end,
  };
}

/** Passes `length` bytes after dropping the first `skip` bytes. */
export function byteWindow(skip: number, length: number): Transform {
  let toSkip = skip;
  let remaining = length;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let data = chunk;
      if (toSkip > 0) {
        const dropped = Math.min(toSkip, data.length);
        toSkip -= dropped;
        data = data.subarray(dropped);
      }
      if (remaining > 0 && data.length > 0) {
        const kept = data.subarray(0, remaining);
        remaining -= kept.length;
        this.push(kept);
      }
      callback();
    },
  });
}
