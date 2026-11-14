/** Maersk JSON shape parsing and local-calendar-date extraction. */
import { firstDefined, jsonArray, jsonPath, jsonString } from "./externalJson";
import type { TrackingEvent } from "./trackingProviders/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a raw date/datetime string into a calendar date "YYYY-MM-DD"
 * WITHOUT shifting it across timezones.
 *
 * Maersk reports arrival dates in the LOCAL time of the port. Round-tripping
 * through Date#toISOString() re-expresses the instant in UTC, which can move
 * the calendar day forward or backward — e.g. "2024-05-10T22:00:00-05:00" is
 * "2024-05-11T03:00:00Z", so toISOString().slice(0,10) yields "2024-05-11",
 * one day AFTER the date Maersk actually shows. To stay faithful to the
 * carrier's displayed date we read the calendar part directly.
 */
export function formatEtaDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Fast path: string already begins with an ISO calendar date — take it
  // verbatim so an explicit offset never drags the day across midnight.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Otherwise let Date parse it (e.g. "May 10, 2024"), then read the LOCAL
  // calendar components rather than the UTC ones.
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Recursively walk any JSON object looking for ETA-named fields.
 * Returns { path, value: "YYYY-MM-DD" } for the first valid date found,
 * or null if none.  Only matches keys whose names explicitly mean
 * estimated/planned/scheduled arrival — never event dates.
 */
const DEEP_ETA_KEY_RE =
  /^(eta|estimatedArrival|estimatedTimeOfArrival|plannedArrival|plannedArrivalDate|scheduledArrival|predictiveEstimatedArrival|latestEstimatedArrival|arrivalDate|vesselArrival|portArrival|destinationEstimatedArrival)$/i;

export function deepScanForEta(obj: unknown, depth = 0): { path: string; value: string } | null {
  if (depth > 12 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepScanForEta(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (DEEP_ETA_KEY_RE.test(k) && typeof v === "string" && v.trim()) {
      const value = formatEtaDate(v);
      if (value) return { path: k, value };
    }
    if (v && typeof v === "object") {
      const r = deepScanForEta(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function parseEvents(rawEvents: unknown[]): TrackingEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents
    .map((e: unknown): TrackingEvent => ({
      date: parseDate(
        firstDefined(
          jsonPath(e, "eventDateTime"),
          jsonPath(e, "eventDate"),
          jsonPath(e, "timestamp"),
          jsonPath(e, "date")
        ) ?? null
      ),
      status: jsonString(
        firstDefined(
          jsonPath(e, "transportEventTypeCode"),
          jsonPath(e, "activityName"),
          jsonPath(e, "eventCode"),
          jsonPath(e, "activity"),
          jsonPath(e, "status")
        )
      ),
      location: jsonString(
        firstDefined(
          jsonPath(e, "location", "portName"),
          jsonPath(e, "location", "locationName"),
          jsonPath(e, "location", "city"),
          jsonPath(e, "portName"),
          jsonPath(e, "locationName"),
          jsonPath(e, "location")
        )
      ),
      description: jsonString(
        firstDefined(jsonPath(e, "description"), jsonPath(e, "eventDescription"), jsonPath(e, "activityName"))
      ),
    }))
    .filter((e) => e.date !== null || e.status !== null)
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });
}

const normContainer = (v: unknown): string =>
  String(v ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();

/**
 * Pick the container the caller actually asked for out of a synergy/generic
 * `containers[]` array. Falls back to the first entry only when no match is
 * found — never blindly trusts index 0, since a response can carry several
 * containers (e.g. a bill-of-lading lookup) and [0] may be a different box.
 */
function pickContainer(list: unknown[], wantContainer?: string) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const wanted = wantContainer ? normContainer(wantContainer) : "";
  if (wanted) {
    const match = list.find((c) =>
      [
        jsonPath(c, "container_num"),
        jsonPath(c, "containerNum"),
        jsonPath(c, "containerNumber"),
        jsonPath(c, "containerNo"),
        jsonPath(c, "number"),
      ].some((n) => normContainer(n) === wanted)
    );
    if (match) return match;
  }
  return list[0];
}

export function extractFromJson(
  data: unknown,
  wantContainer?: string
): {
  events: TrackingEvent[];
  eta: string | null;
  latestStatus: string | null;
  /** True when the structured Maersk "synergy" schema was recognised. */
  synergy: boolean;
} {
  if (!data || typeof data !== "object") return { events: [], eta: null, latestStatus: null, synergy: false };
  const d: unknown = data;

  // ── Maersk "synergy" tracking API format ─────────────────────────────────
  const synergyContainers = jsonArray(jsonPath(d, "containers"));
  if (synergyContainers.length > 0) {
    // Non-null here: pickContainer only returns null for an empty list, and the
    // guard above establishes this one is not empty.
    const c = pickContainer(synergyContainers, wantContainer);
    const locations = jsonArray(jsonPath(c, "locations"));

    if (locations.length > 0) {
      const allEvents: TrackingEvent[] = [];
      for (const loc of locations) {
        const locLabel = [jsonPath(loc, "terminal"), jsonPath(loc, "city"), jsonPath(loc, "country")]
          .filter(Boolean)
          .join(", ");
        for (const ev of jsonArray(jsonPath(loc, "events"))) {
          const eventDate = parseDate(jsonPath(ev, "event_time") ?? null);
          const activity = jsonString(jsonPath(ev, "activity"));
          const vesselName = jsonString(jsonPath(ev, "vessel_name"));
          allEvents.push({
            date: eventDate,
            status: activity,
            location: locLabel,
            description: vesselName
              ? `${activity ?? ""} via ${vesselName} ${jsonString(jsonPath(ev, "voyage_num")) ?? ""}`.trim()
              : activity,
          });
        }
      }

      allEvents.sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.getTime() - a.date.getTime();
      });

      let etaRaw: string | null = jsonString(
        firstDefined(jsonPath(c, "eta_final_delivery"), jsonPath(c, "eta"), jsonPath(d, "eta_final_delivery"))
      );
      if (!etaRaw) {
        // Only look at the LAST location (final destination) for arrival/discharge
        // expected events. Do NOT fall back to earlier transit ports — those
        // expected events are departures, not the destination ETA.
        const lastLoc = locations[locations.length - 1];
        const lastLocEvents = jsonArray(jsonPath(lastLoc, "events"));
        const eventTime = (ev: unknown) => jsonString(jsonPath(ev, "event_time"));
        const isExpected = (ev: unknown) => jsonPath(ev, "event_time_type") === "EXPECTED";

        // Priority 1: expected Arrived / Discharged event at the last location
        const arrivalEv = lastLocEvents.find(
          (ev) =>
            isExpected(ev) &&
            eventTime(ev) &&
            /arrived|discharged|discharge|arrival|delivered|delivery/i.test(jsonString(jsonPath(ev, "activity")) ?? "")
        );
        if (arrivalEv && eventTime(arrivalEv)) {
          etaRaw = eventTime(arrivalEv);
        } else {
          // Priority 2: latest (by event_time) expected event at the last location
          const expectedAtDest = lastLocEvents
            .filter((ev) => isExpected(ev) && eventTime(ev))
            .sort((a, b) => new Date(eventTime(b) ?? "").getTime() - new Date(eventTime(a) ?? "").getTime());
          if (expectedAtDest.length > 0) {
            // Pick the earliest future expected event as the true ETA
            const futureExpected = expectedAtDest
              .slice()
              .reverse()
              .find((ev) => new Date(eventTime(ev) ?? "").getTime() > Date.now());
            etaRaw =
              (futureExpected ? eventTime(futureExpected) : null) ??
              eventTime(expectedAtDest[expectedAtDest.length - 1]);
          }
        }
      }

      const eta = formatEtaDate(etaRaw);

      let latestActualStatus: string | null = null;
      for (let i = locations.length - 1; i >= 0; i--) {
        for (const ev of jsonArray(jsonPath(locations[i], "events")).slice().reverse()) {
          const activity = jsonString(jsonPath(ev, "activity"));
          if (jsonPath(ev, "event_time_type") === "ACTUAL" && activity) {
            latestActualStatus = activity;
            break;
          }
        }
        if (latestActualStatus) break;
      }
      const statusFromField: string | null = jsonString(jsonPath(c, "status"));
      const latestStatus = latestActualStatus ?? statusFromField;

      return { events: allEvents, eta, latestStatus, synergy: true };
    }
  }

  // ── Generic Maersk API format ─────────────────────────────────────────────
  const containers = jsonArray(
    firstDefined(
      jsonPath(d, "shipment", "containers"),
      jsonPath(d, "data", "containers"),
      jsonPath(d, "trackingData", "containers")
    )
  );

  let rawEvents: unknown[] = [];
  let etaRaw: unknown = null;

  if (containers.length > 0) {
    const c = pickContainer(containers, wantContainer);
    rawEvents = jsonArray(
      firstDefined(
        jsonPath(c, "containerEvents"),
        jsonPath(c, "events"),
        jsonPath(c, "milestones"),
        jsonPath(c, "movements")
      )
    );

    // portCalls: destination is the last entry or the one flagged isDestination.
    // NEVER use portCalls[0] — that is the origin.
    const cPortCalls = jsonArray(jsonPath(c, "portCalls"));
    const cDestCall =
      cPortCalls.find(
        (portCall) => jsonPath(portCall, "isDestination") === true || jsonPath(portCall, "isDestination") === "true"
      ) ?? (cPortCalls.length > 0 ? cPortCalls[cPortCalls.length - 1] : null);

    etaRaw = firstDefined(
      jsonPath(cDestCall, "eta"),
      jsonPath(cDestCall, "estimatedArrival"),
      jsonPath(c, "eta"),
      jsonPath(c, "estimatedTimeOfArrival"),
      jsonPath(c, "estimatedArrival"),
      jsonPath(c, "plannedArrivalDate")
    );
  }
  if (!rawEvents.length) {
    rawEvents = jsonArray(
      firstDefined(
        jsonPath(d, "events"),
        jsonPath(d, "milestones"),
        jsonPath(d, "containerEvents"),
        jsonPath(d, "movements"),
        jsonPath(d, "data", "events")
      )
    );
  }
  if (!etaRaw) {
    // Top-level portCalls (some API shapes put them here)
    const dPortCalls = jsonArray(jsonPath(d, "portCalls"));
    const dDestCall =
      dPortCalls.find(
        (portCall) => jsonPath(portCall, "isDestination") === true || jsonPath(portCall, "isDestination") === "true"
      ) ?? (dPortCalls.length > 0 ? dPortCalls[dPortCalls.length - 1] : null);

    etaRaw = firstDefined(
      jsonPath(dDestCall, "eta"),
      jsonPath(dDestCall, "estimatedArrival"),
      jsonPath(d, "eta"),
      jsonPath(d, "estimatedTimeOfArrival"),
      jsonPath(d, "estimatedArrival"),
      jsonPath(d, "plannedArrivalDate"),
      jsonPath(d, "portOfDischarge", "eta"),
      jsonPath(d, "portOfDischarge", "estimatedArrival")
    );
  }

  const events = parseEvents(Array.isArray(rawEvents) ? rawEvents : []);
  const eta = formatEtaDate(etaRaw);

  return { events, eta, latestStatus: null, synergy: false };
}
