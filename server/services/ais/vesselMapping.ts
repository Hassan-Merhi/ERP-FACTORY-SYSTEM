import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { factoryContainers, factoryContainerVesselTracking } from "@shared/schema";
import { normalizeMmsi } from "./aisMessageParser";

export type VesselMappingConfidence = "verified" | "probable" | "manual" | "unknown" | "stale";

export interface VesselIdentity {
  name?: string | null;
  imo?: string | null;
  mmsi?: string | null;
  voyage?: string | null;
  carrier?: string | null;
}

export interface VesselMappingInput extends VesselIdentity {
  source: string;
  confidence: VesselMappingConfidence;
}

function clean(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}

function normalizeImo(value: string | null | undefined): string | null {
  const v = clean(value, 16);
  if (!v) return null;
  const digits = v.toUpperCase().replace(/^IMO\s*/, "");
  return /^\d{7}$/.test(digits) ? digits : null;
}

/**
 * Persist a provider/manual mapping without guessing identifiers. Existing manual
 * mappings are never silently replaced by automatic provider observations.
 */
export async function saveVesselMapping(containerId: number, input: VesselMappingInput) {
  const [container] = await db
    .select({ id: factoryContainers.id, companyId: factoryContainers.companyId })
    .from(factoryContainers)
    .where(eq(factoryContainers.id, containerId))
    .limit(1);
  if (!container) return null;

  const [existing] = await db
    .select()
    .from(factoryContainerVesselTracking)
    .where(
      and(
        eq(factoryContainerVesselTracking.containerId, containerId),
        eq(factoryContainerVesselTracking.companyId, container.companyId)
      )
    )
    .limit(1);

  if (existing?.mappingConfidence === "manual" && input.confidence !== "manual") return existing;

  const mmsi = input.mmsi ? normalizeMmsi(input.mmsi) : null;
  const values = {
    companyId: container.companyId,
    containerId,
    vesselName: clean(input.name, 255),
    imo: normalizeImo(input.imo),
    mmsi,
    voyageNumber: clean(input.voyage, 100),
    carrier: clean(input.carrier, 100),
    mappingSource: clean(input.source, 50),
    mappingConfidence: input.confidence,
    updatedAt: new Date(),
  };

  if (existing) {
    const [row] = await db
      .update(factoryContainerVesselTracking)
      .set(values)
      .where(eq(factoryContainerVesselTracking.id, existing.id))
      .returning();
    return row ?? null;
  }

  const [row] = await db.insert(factoryContainerVesselTracking).values(values).returning();
  return row ?? null;
}

/** Mark a mapping stale without deleting its history/state. */
export async function markVesselMappingStale(containerId: number): Promise<void> {
  await db
    .update(factoryContainerVesselTracking)
    .set({ mappingConfidence: "stale", updatedAt: new Date() })
    .where(eq(factoryContainerVesselTracking.containerId, containerId));
}

/**
 * Conservative extraction from carrier payloads. Only explicit vessel fields are
 * accepted; fuzzy vessel-name matching is intentionally forbidden.
 */
function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractVesselIdentity(raw: unknown): VesselIdentity | null {
  const root = recordValue(Array.isArray(raw) ? raw[0] : raw);
  if (!root) return null;

  const transport = recordValue(root.transport);
  const container = recordValue(Array.isArray(root.containers) ? root.containers[0] : root.container);
  const candidates = [
    recordValue(root.vessel),
    recordValue(root.currentVessel),
    recordValue(transport?.vessel),
    recordValue(container?.vessel),
    recordValue(container?.currentVessel),
  ].filter((value): value is Record<string, unknown> => value !== null);
  const vessel = candidates[0];
  if (!vessel) return null;

  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);
  const result: VesselIdentity = {
    name: text(vessel.name ?? vessel.vesselName ?? vessel.shipName),
    imo: text(vessel.imo ?? vessel.imoNumber ?? vessel.IMO),
    mmsi: text(vessel.mmsi ?? vessel.MMSI),
    voyage: text(vessel.voyage ?? vessel.voyageNumber ?? root.voyageNumber),
  };
  return result.name || result.imo || result.mmsi ? result : null;
}
