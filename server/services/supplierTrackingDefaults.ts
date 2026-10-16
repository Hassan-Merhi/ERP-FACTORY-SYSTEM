import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  agentDeclarantMappings,
  containers,
  locations,
  supplierTrackingDefaults,
  type UpsertSupplierTrackingDefault,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";

export function isBlankTrackingValue(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

export function resolveTrackingDefaults(
  current: { shopName?: string | null; agent?: string | null },
  defaults: { locationName?: string | null; agentName?: string | null }
) {
  return {
    shopName:
      isBlankTrackingValue(current.shopName) && !isBlankTrackingValue(defaults.locationName)
        ? defaults.locationName!.trim()
        : current.shopName,
    agent:
      isBlankTrackingValue(current.agent) && !isBlankTrackingValue(defaults.agentName)
        ? defaults.agentName!.trim()
        : current.agent,
  };
}

/** Null means no explicit container duty; 0 is a valid manual amount. */
export function resolveTrackingDutyFee(current: string | null | undefined, fallback: string | null | undefined) {
  return current == null ? (fallback ?? null) : current;
}

async function assertSupplierInCompany(companyId: number, supplierId: number) {
  const [supplier] = await db
    .select({ id: companyScopedSuppliers.id })
    .from(companyScopedSuppliers)
    .where(
      and(
        eq(companyScopedSuppliers.id, supplierId),
        eq(companyScopedSuppliers.companyId, companyId),
        isNull(companyScopedSuppliers.deletedAt)
      )
    )
    .limit(1);

  if (!supplier) throw new Error("Supplier not found in the selected company");
}

async function assertLocationInCompany(companyId: number, locationId: number) {
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .limit(1);

  if (!location) throw new Error("Location not found in the selected company");
}

export async function listSupplierTrackingDefaults(companyId: number) {
  const [supplierRows, locationRows, mappedAgents, usedAgents] = await Promise.all([
    db
      .select({
        supplierId: companyScopedSuppliers.id,
        supplierCode: companyScopedSuppliers.code,
        supplierName: companyScopedSuppliers.legalName,
        locationId: supplierTrackingDefaults.locationId,
        shopName: supplierTrackingDefaults.shopName,
        agentName: supplierTrackingDefaults.agentName,
        dutyFee: supplierTrackingDefaults.dutyFee,
      })
      .from(companyScopedSuppliers)
      .leftJoin(
        supplierTrackingDefaults,
        and(
          eq(supplierTrackingDefaults.companyId, companyId),
          eq(supplierTrackingDefaults.supplierId, companyScopedSuppliers.id),
          eq(supplierTrackingDefaults.active, true)
        )
      )
      .where(
        and(
          eq(companyScopedSuppliers.companyId, companyId),
          eq(companyScopedSuppliers.active, true),
          isNull(companyScopedSuppliers.deletedAt)
        )
      )
      .orderBy(asc(companyScopedSuppliers.legalName)),
    db
      .select({ id: locations.id, code: locations.code, name: locations.name })
      .from(locations)
      .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
      .orderBy(asc(locations.name)),
    db
      .select({ name: agentDeclarantMappings.agentName })
      .from(agentDeclarantMappings)
      .where(and(eq(agentDeclarantMappings.companyId, companyId), eq(agentDeclarantMappings.active, true))),
    db.select({ name: containers.agent }).from(containers).where(eq(containers.companyId, companyId)),
  ]);

  const activeLocationNames = new Map(locationRows.map((location) => [location.id, location.name]));
  const suppliers = supplierRows.map((row) => ({
    ...row,
    // Continue showing legacy location mappings as editable text.
    shopName: row.shopName?.trim() || (row.locationId ? activeLocationNames.get(row.locationId) : null) || null,
    // A soft-deleted/deactivated location cannot be used as a default.
    locationId: row.locationId && activeLocationNames.has(row.locationId) ? row.locationId : null,
  }));

  const agentOptions = Array.from(
    new Set(
      [...mappedAgents, ...usedAgents].map((row) => row.name?.trim()).filter((name): name is string => Boolean(name))
    )
  ).sort((a, b) => a.localeCompare(b));

  return { suppliers, locations: locationRows, agentOptions };
}

export async function saveSupplierTrackingDefault(
  companyId: number,
  supplierId: number,
  input: UpsertSupplierTrackingDefault
) {
  await assertSupplierInCompany(companyId, supplierId);

  const shopName = input.shopName?.trim() || null;
  const locationId = shopName ? null : (input.locationId ?? null);
  const agentName = input.agentName?.trim() || null;
  const dutyFee = input.dutyFee?.trim() || null;
  if (locationId !== null) await assertLocationInCompany(companyId, locationId);

  if (locationId === null && shopName === null && agentName === null && dutyFee === null) {
    await db
      .delete(supplierTrackingDefaults)
      .where(
        and(eq(supplierTrackingDefaults.companyId, companyId), eq(supplierTrackingDefaults.supplierId, supplierId))
      );
    return null;
  }

  const [saved] = await db
    .insert(supplierTrackingDefaults)
    .values({ companyId, supplierId, locationId, shopName, agentName, dutyFee, active: true })
    .onConflictDoUpdate({
      target: [supplierTrackingDefaults.companyId, supplierTrackingDefaults.supplierId],
      set: { locationId, shopName, agentName, dutyFee, active: true, updatedAt: new Date() },
    })
    .returning();

  return saved;
}

export async function backfillSupplierTrackingDefaults(companyId: number) {
  const rows = await db
    .select({
      containerId: containers.id,
      shopName: containers.shopName,
      agent: containers.agent,
      dutyFee: containers.dutyFee,
      locationName: locations.name,
      defaultShopName: supplierTrackingDefaults.shopName,
      agentName: supplierTrackingDefaults.agentName,
      defaultDutyFee: supplierTrackingDefaults.dutyFee,
    })
    .from(containers)
    .innerJoin(
      supplierTrackingDefaults,
      and(
        eq(supplierTrackingDefaults.companyId, containers.companyId),
        eq(supplierTrackingDefaults.supplierId, containers.supplierId),
        eq(supplierTrackingDefaults.active, true)
      )
    )
    .leftJoin(
      locations,
      and(
        eq(locations.id, supplierTrackingDefaults.locationId),
        eq(locations.companyId, containers.companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .where(eq(containers.companyId, companyId));

  let containersUpdated = 0;
  let shopsFilled = 0;
  let agentsFilled = 0;
  let dutiesFilled = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const resolved = resolveTrackingDefaults(
        { shopName: row.shopName, agent: row.agent },
        { locationName: row.defaultShopName?.trim() || row.locationName, agentName: row.agentName }
      );
      const resolvedDutyFee = resolveTrackingDutyFee(row.dutyFee, row.defaultDutyFee);
      const patch: { shopName?: string; agent?: string; dutyFee?: string } = {};

      if (isBlankTrackingValue(row.shopName) && !isBlankTrackingValue(resolved.shopName)) {
        patch.shopName = resolved.shopName!;
        shopsFilled++;
      }
      if (isBlankTrackingValue(row.agent) && !isBlankTrackingValue(resolved.agent)) {
        patch.agent = resolved.agent!;
        agentsFilled++;
      }
      if (row.dutyFee == null && resolvedDutyFee != null) {
        patch.dutyFee = resolvedDutyFee;
        dutiesFilled++;
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(containers).set(patch).where(eq(containers.id, row.containerId));
        containersUpdated++;
      }
    }
  });

  return { containersUpdated, shopsFilled, agentsFilled, dutiesFilled };
}
