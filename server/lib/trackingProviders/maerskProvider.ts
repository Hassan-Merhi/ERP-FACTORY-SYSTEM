/**
 * maerskProvider.ts — Maersk Line official developer API tracking.
 *
 * Free registration (no credit card):
 *   https://developer.maersk.com → sign up → create app → subscribe "Track & Trace"
 *
 * Required env vars (never logged, never sent to frontend):
 *   MAERSK_CONSUMER_KEY
 *   MAERSK_CONSUMER_SECRET
 *
 * When credentials are absent this provider returns { notConfigured: true }
 * and the tracking service falls back to ParcelsApp automatically.
 */

import type { CarrierTrackResult, TrackingEvent } from "./types";
import { getErrorMessage } from "../../lib/httpHandlers";

const API_BASE = "https://api.maersk.com";
const TOKEN_URL = `${API_BASE}/oauth2/access_token`;

// ── In-memory OAuth2 token cache ─────────────────────────────────────────────
// Tokens typically last 3 600 s; we refresh 60 s before expiry.
let _token: { value: string; expiresAt: number } | null = null;

export function isConfigured(): boolean {
  return !!(process.env.MAERSK_CONSUMER_KEY && process.env.MAERSK_CONSUMER_SECRET);
}

async function fetchToken(): Promise<string> {
  if (_token && Date.now() < _token.expiresAt - 60_000) {
    return _token.value;
  }

  const key = process.env.MAERSK_CONSUMER_KEY!;
  const secret = process.env.MAERSK_CONSUMER_SECRET!;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Consumer-Key": key,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: key,
      client_secret: secret,
    }).toString(),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Maersk OAuth ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3_600) * 1_000,
  };
  return _token.value;
}

// ── Response parsers ──────────────────────────────────────────────────────────

function parseDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function parseEvents(rawEvents: unknown): TrackingEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents
    .map((e): TrackingEvent => {
      const date = parseDate(e.eventDateTime ?? e.eventDate ?? e.date ?? null);
      const location = e.location?.locationName ?? e.location?.UNLocationCode ?? e.portName ?? e.locationName ?? null;
      const status = e.transportEventTypeCode ?? e.eventCode ?? e.eventType ?? e.status ?? null;
      const description = e.description ?? e.eventDescription ?? null;
      return { date, status, location, description };
    })
    .filter((e) => e.date !== null || e.status !== null);
}

function pickEta(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;

  // portCalls: destination is the last entry or explicitly flagged isDestination.
  // NEVER use portCalls[0] — that is the origin.
  const portCalls: Record<string, unknown>[] = Array.isArray(obj.portCalls) ? obj.portCalls : [];
  const destPortCall =
    portCalls.find((p) => p.isDestination === true || p.isDestination === "true") ??
    (portCalls.length > 0 ? portCalls[portCalls.length - 1] : null);

  const portOfDischarge =
    obj.portOfDischarge && typeof obj.portOfDischarge === "object"
      ? (obj.portOfDischarge as Record<string, unknown>)
      : null;

  // Destination port fields outrank generic top-level fields which may refer
  // to any leg of the journey rather than the final destination.
  const raw =
    destPortCall?.eta ??
    destPortCall?.estimatedArrival ??
    destPortCall?.estimatedTimeOfArrival ??
    portOfDischarge?.eta ??
    portOfDischarge?.estimatedArrival ??
    portOfDischarge?.estimatedTimeOfArrival ??
    obj.eta ??
    obj.estimatedArrival ??
    obj.estimatedTimeOfArrival ??
    obj.estimatedDelivery ??
    null;
  const d = parseDate(raw);
  return d ? d.toISOString().slice(0, 10) : null;
}

// ── Public track function ─────────────────────────────────────────────────────

export async function track(containerNumber: string): Promise<CarrierTrackResult> {
  if (!isConfigured()) {
    return {
      success: false,
      provider: "maersk",
      carrier: "MAERSK",
      containerNumber,
      latestStatus: null,
      latestLocation: null,
      latestEventDate: null,
      latestDescription: null,
      eta: null,
      events: [],
      raw: null,
      notConfigured: true,
      error: "maersk_not_configured",
    };
  }

  try {
    const token = await fetchToken();
    const key = process.env.MAERSK_CONSUMER_KEY!;

    const res = await fetch(`${API_BASE}/track/${encodeURIComponent(containerNumber)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Consumer-Key": key,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 401/403 → invalidate cached token so next attempt re-fetches
      if (res.status === 401 || res.status === 403) _token = null;
      throw new Error(`Maersk API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const raw: unknown = await res.json();

    // Response is usually an array; normalise to the first entry.
    const entry = Array.isArray(raw) ? raw[0] : raw;
    if (!entry) throw new Error("Maersk returned empty response");

    // Events may be on entry.events or entry.containers[0].events
    const rawEvents: unknown =
      entry.events ?? entry.containers?.[0]?.events ?? entry.ContainerStatus?.[0]?.events ?? [];

    // Sort newest-first so events[0] is the latest
    const events = parseEvents(rawEvents).sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

    const latest = events[0] ?? null;

    const latestStatus =
      entry.latestStatus ??
      entry.status ??
      entry.containers?.[0]?.status ??
      entry.ContainerStatus?.[0]?.Status ??
      latest?.status ??
      null;

    const latestLocation = entry.location?.locationName ?? latest?.location ?? null;

    const latestDescription = latest?.description ?? null;
    const latestEventDate = latest?.date ?? null;

    const eta = pickEta(entry) ?? pickEta(entry.containers?.[0]) ?? null;

    return {
      success: true,
      provider: "maersk",
      carrier: "MAERSK",
      containerNumber,
      latestStatus,
      latestLocation,
      latestEventDate,
      latestDescription,
      eta,
      events,
      raw,
    };
  } catch (err: unknown) {
    if (getErrorMessage(err)?.includes("401") || getErrorMessage(err)?.includes("403")) {
      _token = null;
    }
    return {
      success: false,
      provider: "maersk",
      carrier: "MAERSK",
      containerNumber,
      latestStatus: null,
      latestLocation: null,
      latestEventDate: null,
      latestDescription: null,
      eta: null,
      events: [],
      raw: null,
      error: getErrorMessage(err) ?? "maersk_api_error",
    };
  }
}
