/**
 * puppeteerSemaphore.ts — Global Puppeteer concurrency gate.
 *
 * Guarantees at most one Puppeteer browser/page operation runs simultaneously
 * across the server process. Waiting callers are bounded by both queue depth
 * and time so a stalled browser cannot accumulate promises indefinitely.
 */

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Each headless Chrome instance can use hundreds of MB. Keep one active by
// default, while allowing an explicit deployment override when capacity grows.
const MAX_CONCURRENT = parsePositiveInt(process.env.PUPPETEER_MAX_CONCURRENT, 1);
const MAX_QUEUE_DEPTH = parsePositiveInt(process.env.PUPPETEER_MAX_QUEUE_DEPTH, 6);
const QUEUE_WAIT_TIMEOUT_MS = parsePositiveInt(process.env.PUPPETEER_QUEUE_WAIT_TIMEOUT_MS, 2 * 60 * 1000);

let running = 0;
type QueueEntry = {
  tryGrab: () => void;
  timeout: ReturnType<typeof setTimeout>;
};
const queue: QueueEntry[] = [];

function dispatchNext(): void {
  if (running >= MAX_CONCURRENT) return;
  const next = queue.shift();
  if (!next) return;
  clearTimeout(next.timeout);
  next.tryGrab();
}

export function acquirePuppeteerSlot(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (running >= MAX_CONCURRENT && queue.length >= MAX_QUEUE_DEPTH) {
      reject(new Error("PUPPETEER_QUEUE_FULL"));
      return;
    }

    let settled = false;
    let entry: QueueEntry | null = null;

    const tryGrab = () => {
      if (settled) return;
      if (running < MAX_CONCURRENT) {
        settled = true;
        running += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          running = Math.max(0, running - 1);
          dispatchNext();
        });
        return;
      }

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (entry) {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
        }
        reject(new Error("PUPPETEER_QUEUE_TIMEOUT"));
      }, QUEUE_WAIT_TIMEOUT_MS);
      timeout.unref?.();
      entry = { tryGrab, timeout };
      queue.push(entry);
    };

    tryGrab();
  });
}
