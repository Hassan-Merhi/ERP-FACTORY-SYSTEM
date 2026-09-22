import WebSocket, { type RawData } from "ws";
import { logger } from "../../lib/logger";
import { isAisStreamSubscriptionConfirmation, parseAisStreamMessage, normalizeMmsi } from "./aisMessageParser";
import { recordAisControlMessage, recordAisError, recordAisMessage, recordAisReconnect, setAisState } from "./aisHealth";
import type { AisUpdate } from "./aisTypes";

const DEFAULT_URL = "wss://stream.aisstream.io/v0/stream";
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

export interface AisStreamClientOptions {
  mmsis: string[];
  onUpdate: (update: AisUpdate) => void | Promise<void>;
  url?: string;
}

/**
 * Low-level AISStream transport. Wave 3 will own lifecycle/subscription selection;
 * this class intentionally does not auto-start at module import time.
 */
export class AisStreamClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private mmsis: string[];

  constructor(private readonly options: AisStreamClientOptions) {
    this.mmsis = this.cleanMmsis(options.mmsis);
  }

  start(): boolean {
    if (!process.env.AISSTREAM_API_KEY) {
      setAisState("disabled");
      logger.info("[AISStream] disabled: AISSTREAM_API_KEY is not configured");
      return false;
    }
    if (!this.stopped) return true;
    this.stopped = false;
    this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    setAisState("stopped");
  }

  setMmsis(mmsis: string[]): void {
    const next = this.cleanMmsis(mmsis);
    if (next.join(",") === this.mmsis.join(",")) return;
    this.mmsis = next;
    // AISStream subscriptions are established on connection; reconnect safely
    // when the active filter changes rather than maintaining competing sockets.
    if (!this.stopped && this.socket) {
      this.socket.close(1000, "subscription changed");
    }
  }

  private cleanMmsis(values: string[]): string[] {
    return [...new Set(values.map(normalizeMmsi).filter((value): value is string => Boolean(value)))].sort();
  }

  private connect(): void {
    if (this.stopped) return;
    setAisState(this.reconnectAttempt ? "reconnecting" : "connecting");
    const socket = new WebSocket(this.options.url ?? process.env.AISSTREAM_URL ?? DEFAULT_URL);
    this.socket = socket;

    socket.on("open", () => {
      if (this.stopped || socket !== this.socket) return;
      this.reconnectAttempt = 0;
      setAisState("connected");
      socket.send(JSON.stringify({
        APIKey: process.env.AISSTREAM_API_KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: this.mmsis,
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      }));
      logger.info(`[AISStream] connected; subscribed MMSIs=${this.mmsis.length}`);
    });

    socket.on("message", (data: RawData) => {
      const raw = Buffer.isBuffer(data) ? data : data.toString();
      if (isAisStreamSubscriptionConfirmation(raw)) {
        recordAisControlMessage();
        return;
      }

      const update = parseAisStreamMessage(raw);
      recordAisMessage(Boolean(update));
      if (!update) return;
      Promise.resolve(this.options.onUpdate(update)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "AIS update handler failed";
        recordAisError(message);
        logger.warn("[AISStream] update handler failed", { error: message });
      });
    });

    socket.on("error", (error) => {
      // Never log the subscription payload/API key.
      recordAisError(error.message);
      logger.warn("[AISStream] websocket error", { error: error.message });
    });

    socket.on("close", () => {
      if (socket === this.socket) this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    recordAisReconnect();
    setAisState("reconnecting");
    const exponential = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** Math.min(this.reconnectAttempt - 1, 6));
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
