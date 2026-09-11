import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../lib/logger";

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_QUEUE = 6;
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const STATE_KEY = Symbol.for("erp.heavy-export-coordinator.state");
const CONTEXT_KEY = Symbol.for("erp.heavy-export-coordinator.context");

interface QueueEntry {
  label: string;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface CoordinatorState {
  active: number;
  queue: QueueEntry[];
}

interface SlotContext {
  active: true;
  label: string;
}

// The coordinator state must survive module reloads, so it lives on globalThis
// under a Symbol.for key. typeof globalThis has no symbol index, so the slot
// bag is read through a symbol-keyed view instead of casting to any.
const globalSlots = globalThis as unknown as Record<symbol, unknown>;

const state: CoordinatorState = (globalSlots[STATE_KEY] ??= {
  active: 0,
  queue: [],
}) as CoordinatorState;

const slotContext: AsyncLocalStorage<SlotContext> = (globalSlots[CONTEXT_KEY] ??=
  new AsyncLocalStorage<SlotContext>()) as AsyncLocalStorage<SlotContext>;

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxConcurrent(): number {
  return readPositiveInt("HEAVY_EXPORT_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
}

function maxQueue(): number {
  return readPositiveInt("HEAVY_EXPORT_MAX_QUEUE", DEFAULT_MAX_QUEUE);
}

function waitTimeoutMs(): number {
  return readPositiveInt("HEAVY_EXPORT_WAIT_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS);
}

function dispatch(): void {
  while (state.active < maxConcurrent() && state.queue.length > 0) {
    const entry = state.queue.shift()!;
    clearTimeout(entry.timeout);
    state.active += 1;

    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      logger.info("Heavy export slot released", {
        module: "heavy-export-coordinator",
        action: "release",
        label: entry.label,
        active: state.active,
        queued: state.queue.length,
      });
      dispatch();
    });

    logger.info("Heavy export slot acquired", {
      module: "heavy-export-coordinator",
      action: "acquire",
      label: entry.label,
      waitMs: Date.now() - entry.enqueuedAt,
      active: state.active,
      queued: state.queue.length,
    });
  }
}

export function getHeavyExportState() {
  return {
    active: state.active,
    queued: state.queue.length,
    maxConcurrent: maxConcurrent(),
    maxQueue: maxQueue(),
  };
}

export function isHeavyExportSlotActive(): boolean {
  return slotContext.getStore()?.active === true;
}

export async function acquireHeavyExportSlot(label: string): Promise<() => void> {
  if (state.queue.length >= maxQueue() && state.active >= maxConcurrent()) {
    throw new Error(
      `Export capacity reached (${state.active} active, ${state.queue.length} queued). Try again after the current export finishes.`
    );
  }

  return new Promise<() => void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = state.queue.findIndex((entry) => entry.timeout === timeout);
      if (index >= 0) state.queue.splice(index, 1);
      reject(new Error(`Timed out waiting for export capacity after ${Math.round(waitTimeoutMs() / 60000)} minutes.`));
    }, waitTimeoutMs());
    timeout.unref?.();

    state.queue.push({ label, enqueuedAt: Date.now(), resolve, reject, timeout });
    dispatch();
  });
}

export async function withHeavyExportSlot<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (isHeavyExportSlotActive()) return work();

  const release = await acquireHeavyExportSlot(label);
  return slotContext.run({ active: true, label }, async () => {
    try {
      return await work();
    } finally {
      release();
    }
  });
}
