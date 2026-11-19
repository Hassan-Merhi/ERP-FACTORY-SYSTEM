// Extracted from ./maerskDirectParsing.ts
import { firstDefined, jsonPath, jsonString } from "./externalJson";
import type { TrackingEvent } from "./trackingProviders/types";

export function parseDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Recursively walk any JSON object looking for ETA-named fields.
 * Returns { path, value: "YYYY-MM-DD" } for the first valid date found,
 * or null if none.  Only matches keys whose names explicitly mean
 * estimated/planned/scheduled arrival — never event dates.
 */
export const DEEP_ETA_KEY_RE =
  /^(eta|estimatedArrival|estimatedTimeOfArrival|plannedArrival|plannedArrivalDate|scheduledArrival|predictiveEstimatedArrival|latestEstimatedArrival|arrivalDate|vesselArrival|portArrival|destinationEstimatedArrival)$/i;

export function parseEvents(rawEvents: unknown[]): TrackingEvent[] {
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
