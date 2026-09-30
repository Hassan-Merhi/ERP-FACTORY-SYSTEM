import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";

import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { ensureHistoricalSalesCostRepairSchema } from "./ensureHistoricalSalesCostRepairSchema";
import {
  HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  repairRate,
  replayHistoricalSalesCosts,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairOpening,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";

type RepairCheck = {
  companyId: number;
  locationId: number | null;
  stockItemId: number | null;
  code: string;
  status: "pass" | "block" | "warning";
  expected?: string | null;
  actual?: string | null;
  detail?: string | null;
};

type InventoryRow = {
  location_id: number;
  stock_item_id: number;
  quantity: string;
  average_rate: string;
  total_value: string;
};

type StockItemRow = {
  id: number;
  code: string | null;
  opening_qty: string;
  opening_rate: string;
  opening_value: string;
};

type CanonicalRow = {
  id: number;
  location_id: number;
  stock_item_id: number;
  quantity_delta: string;
  unit_cost: string;
  source_type: string;
  source_id: string;
  occurred_at: Date;
  created_at: Date;
};

type SaleRow = {
  sales_item_id: number;
  voucher_id: number;
  location_id: number | null;
  stock_item_id: number;
  quantity: string;
  total_sales: string;
  cost_price: string;
  total_cost: string;
  profit: string;
  created_at: Date;
};

type LegacyRow = {
  movement_id: string;
  location_id: number;
  stock_item_id: number;
  quantity_delta: string;
  unit_cost: string | null;
  occurred_at: Date;
  sequence: number;
  source_type: string;
  source_id: string;
};

type AuditInventoryRow = {
  id: number;
  stock_item_id: number | null;
  location_name: string | null;
  old_quantity: string | null;
  new_quantity: string | null;
  created_at: Date;
};

type CompanyDryRun = {
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
  report: Record<string, unknown>;
};

const QTY_TOLERANCE = new Decimal("0.001");
const MONEY_TOLERANCE = new Decimal("0.02");

function d(value: Decimal.Value | null | undefined): Decimal {
  const parsed = new Decimal(value ?? 0);
  if (!parsed.isFinite()) throw new Error(`Historical sales cost repair encountered non-finite value: ${String(value)}`);
  return parsed;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid repair timestamp: ${String(value)}`);
  return date.toISOString();
}

function beforeCutoff(value: Date, canonicalStart: Date | null): boolean {
  return canonicalStart === null || value.getTime() < canonicalStart.getTime();
}

async function enableMaintenanceScope(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
  await client.query("SELECT set_config('app.current_company_id', '', true)");
  await client.query("SELECT set_config('app.authorized_company_ids', '', true)");
}

async function companyIdsForRun(client: PoolClient, requested?: number[]): Promise<number[]> {
  if (requested?.length) {
    const unique = [...new Set(requested.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    const existing = await client.query<{ id: number }>(
      "SELECT id FROM companies WHERE id = ANY($1::int[]) ORDER BY id",
      [unique]
    );
    if (existing.rows.length !== unique.length) {
      throw new Error("Historical sales cost repair refused: one or more requested companies do not exist");
    }
    return existing.rows.map((row) => Number(row.id));
  }
  const all = await client.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  return all.rows.map((row) => Number(row.id));
}

async function loadCanonicalStart(client: PoolClient, companyId: number, sourceCutoff: Date): Promise<Date | null> {
  const result = await client.query<{ started_at: Date | null }>(
    `SELECT MIN(created_at) AS started_at
       FROM canonical_stock_movements
      WHERE company_id=$1 AND created_at <= $2`,
    [companyId, sourceCutoff]
  );
  return result.rows[0]?.started_at ?? null;
}

async function loadCanonicalMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<HistoricalSalesRepairMovement[]> {
  if (!canonicalStart) return [];
  const rows = await client.query<CanonicalRow>(
    `SELECT id,location_id,stock_item_id,quantity_delta::text,unit_cost::text,
            source_type,source_id,occurred_at,created_at
       FROM canonical_stock_movements
      WHERE company_id=$1
        AND created_at >= $2
        AND created_at <= $3
      ORDER BY occurred_at,id`,
    [companyId, canonicalStart, sourceCutoff]
  );
  return rows.rows.map((row) => ({
    movementId: `canonical:${row.id}`,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    sequence: Number(row.id) * 10 + 5,
    quantityDelta: String(row.quantity_delta),
    unitCost: String(row.unit_cost),
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "canonical" as const,
  }));
}

async function loadSales(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<SaleRow[]> {
  const rows = await client.query<SaleRow>(
    `SELECT si.id AS sales_item_id,si.voucher_id,v.location_id,si.stock_item_id,
            si.quantity::text,si.total_sales::text,si.cost_price::text,
            si.total_cost::text,si.profit::text,
            GREATEST(si.created_at,v.created_at) AS created_at
       FROM sales_items si
       JOIN vouchers v ON v.id=si.voucher_id
      WHERE v.company_id=$1
        AND v.voucher_type='Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(si.created_at,v.created_at) <= $2
      ORDER BY GREATEST(si.created_at,v.created_at),si.id`,
    [companyId, sourceCutoff]
  );
  return rows.rows;
}

async function loadLegacyMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<LegacyRow[]> {
  const params = [companyId, canonicalStart, sourceCutoff];
  const rows = await client.query<LegacyRow>(
    `
    WITH boundary AS (
      SELECT $1::int AS company_id,$2::timestamptz AS canonical_start,$3::timestamptz AS source_cutoff
    ),
    offloads AS (
      SELECT
        'offload:'||coi.id::text AS movement_id,
        co.location_id,
        coi.stock_item_id,
        coi.quantity::text AS quantity_delta,
        coi.rate::text AS unit_cost,
        co.offloaded_at AS occurred_at,
        coi.id*10+1 AS sequence,
        'legacy-container-offload'::text AS source_type,
        co.id::text AS source_id
      FROM container_offload_items coi
      JOIN container_offloads co ON co.id=coi.offload_id
      JOIN containers c ON c.id=co.container_id
      JOIN boundary b ON b.company_id=c.company_id
      WHERE COALESCE(co.optional,false)=false
        AND co.offloaded_at <= b.source_cutoff
        AND (b.canonical_start IS NULL OR co.offloaded_at < b.canonical_start)
    ),
    adjustments AS (
      SELECT
        'adjustment:'||sai.id::text,
        sav.location_id,
        sai.stock_item_id,
        sai.quantity::text,
        sai.rate::text,
        GREATEST(sai.created_at,sav.created_at,v.created_at),
        sai.id*10+2,
        'legacy-stock-adjustment',
        sav.id::text
      FROM stock_adjustment_items sai
      JOIN stock_adjustment_vouchers sav ON sav.id=sai.adjustment_id
      JOIN vouchers v ON v.id=sav.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sai.created_at,sav.created_at,v.created_at) <= b.source_cutoff
        AND (b.canonical_start IS NULL OR GREATEST(sai.created_at,sav.created_at,v.created_at) < b.canonical_start)
    ),
    transfer_source AS (
      SELECT
        'transfer-out:'||sti.id::text,
        COALESCE(sti.source_location_id,stv.source_location_id) AS location_id,
        sti.stock_item_id,
        (-ABS(sti.quantity))::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+3,
        'legacy-stock-transfer-out',
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE stv.inventory_applied=true
        AND COALESCE(sti.source_location_id,stv.source_location_id) IS NOT NULL
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND (b.canonical_start IS NULL OR GREATEST(sti.created_at,stv.created_at,v.created_at) < b.canonical_start)
    ),
    transfer_destination AS (
      SELECT
        'transfer-in:'||sti.id::text,
        stv.destination_location_id,
        sti.stock_item_id,
        ABS(sti.quantity)::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+4,
        'legacy-stock-transfer-in',
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE stv.inventory_applied=true
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND (b.canonical_start IS NULL OR GREATEST(sti.created_at,stv.created_at,v.created_at) < b.canonical_start)
    ),
    notes AS (
      SELECT
        'note:'||cni.id::text,
        cni.location_id,
        cni.stock_item_id,
        (CASE WHEN v.voucher_type='Credit Note' THEN ABS(cni.quantity) ELSE -ABS(cni.quantity) END)::text,
        NULL::text,
        GREATEST(cni.created_at,v.created_at),
        cni.id*10+6,
        CASE WHEN v.voucher_type='Credit Note' THEN 'legacy-credit-note' ELSE 'legacy-debit-note' END,
        v.id::text
      FROM credit_note_items cni
      JOIN vouchers v ON v.id=cni.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.voucher_type IN ('Credit Note','Debit Note')
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(cni.created_at,v.created_at) <= b.source_cutoff
        AND (b.canonical_start IS NULL OR GREATEST(cni.created_at,v.created_at) < b.canonical_start)
    ),
    archive_out AS (
      SELECT
        'archive-out:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        (-ABS(ai.quantity))::text,
        ai.average_rate::text,
        a.archived_at,
        ai.id*10+7,
        'legacy-stock-group-archive',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.archived_at <= b.source_cutoff
        AND (b.canonical_start IS NULL OR a.archived_at < b.canonical_start)
    ),
    archive_in AS (
      SELECT
        'archive-in:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        ABS(ai.quantity)::text,
        ai.average_rate::text,
        a.restored_at,
        ai.id*10+8,
        'legacy-stock-group-archive-restore',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.restored_at IS NOT NULL
        AND a.restored_at <= b.source_cutoff
        AND (b.canonical_start IS NULL OR a.restored_at < b.canonical_start)
    )
    SELECT * FROM offloads
    UNION ALL SELECT * FROM adjustments
    UNION ALL SELECT * FROM transfer_source
    UNION ALL SELECT * FROM transfer_destination
    UNION ALL SELECT * FROM notes
    UNION ALL SELECT * FROM archive_out
    UNION ALL SELECT * FROM archive_in
    ORDER BY occurred_at,sequence
    `,
    params
  );
  return rows.rows;
}

async function loadLegacyManualAdjustments(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<{ movements: LegacyRow[]; checks: RepairCheck[] }> {
  const rows = await client.query<AuditInventoryRow>(
    `SELECT id,record_id AS stock_item_id,
            changes->'location'->>'new' AS location_name,
            changes->'quantity'->>'old' AS old_quantity,
            changes->'quantity'->>'new' AS new_quantity,
            created_at
       FROM audit_log
      WHERE company_id=$1
        AND table_name='inventory'
        AND action='update'
        AND changes ? 'adjustmentType'
        AND changes ? 'quantity'
        AND created_at <= $3
        AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at,id`,
    [companyId, canonicalStart, sourceCutoff]
  );

  const movements: LegacyRow[] = [];
  const checks: RepairCheck[] = [];
  for (const row of rows.rows) {
    if (!row.stock_item_id || !row.location_name || row.old_quantity === null || row.new_quantity === null) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: row.stock_item_id ? Number(row.stock_item_id) : null,
        code: "LEGACY_MANUAL_ADJUSTMENT_UNRESOLVED",
        status: "block",
        detail: `Audit row ${row.id} is missing item/location/quantity evidence`,
      });
      continue;
    }

    const locations = await client.query<{ id: number }>(
      `SELECT id FROM locations
        WHERE company_id=$1 AND name=$2
        ORDER BY id`,
      [companyId, row.location_name]
    );
    if (locations.rows.length !== 1) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(row.stock_item_id),
        code: "LEGACY_MANUAL_ADJUSTMENT_LOCATION_AMBIGUOUS",
        status: "block",
        actual: String(locations.rows.length),
        detail: `Audit row ${row.id} location "${row.location_name}" did not resolve to exactly one location`,
      });
      continue;
    }

    const delta = d(row.new_quantity).minus(d(row.old_quantity));
    if (delta.isZero()) continue;
    movements.push({
      movement_id: `manual-audit:${row.id}`,
      location_id: Number(locations.rows[0].id),
      stock_item_id: Number(row.stock_item_id),
      quantity_delta: repairQuantity(delta).toFixed(3),
      unit_cost: null,
      occurred_at: row.created_at,
      sequence: Number(row.id) * 10 + 9,
      source_type: "legacy-manual-inventory-adjustment",
      source_id: String(row.id),
    });
  }
  return { movements, checks };
}

function addMovementNet(
  net: Map<string, Decimal>,
  companyId: number,
  movement: Pick<HistoricalSalesRepairMovement, "locationId" | "stockItemId" | "quantityDelta">
): void {
  const key = historicalInventoryKey(companyId, movement.locationId, movement.stockItemId);
  net.set(key, (net.get(key) ?? new Decimal(0)).plus(d(movement.quantityDelta)));
}

function buildOpeningStates(input: {
  companyId: number;
  stockItems: StockItemRow[];
  liveInventory: InventoryRow[];
  movements: HistoricalSalesRepairMovement[];
}): { openings: HistoricalSalesRepairOpening[]; checks: RepairCheck[]; derivedOpeningByKey: Map<string, Decimal> } {
  const { companyId, stockItems, liveInventory, movements } = input;
  const checks: RepairCheck[] = [];
  const movementNet = new Map<string, Decimal>();
  for (const movement of movements) addMovementNet(movementNet, companyId, movement);

  const liveByKey = new Map<string, Decimal>();
  for (const row of liveInventory) {
    liveByKey.set(
      historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id)),
      repairQuantity(row.quantity)
    );
  }

  const allKeys = new Set([...liveByKey.keys(), ...movementNet.keys()]);
  const derivedOpeningByKey = new Map<string, Decimal>();
  for (const key of allKeys) {
    derivedOpeningByKey.set(
      key,
      repairQuantity((liveByKey.get(key) ?? new Decimal(0)).minus(movementNet.get(key) ?? new Decimal(0)))
    );
  }

  const itemMap = new Map(stockItems.map((item) => [Number(item.id), item]));
  const keysByItem = new Map<number, string[]>();
  for (const key of allKeys) {
    const stockItemId = Number(key.split(":")[2]);
    const keys = keysByItem.get(stockItemId) ?? [];
    keys.push(key);
    keysByItem.set(stockItemId, keys);
  }

  const openings: HistoricalSalesRepairOpening[] = [];
  for (const [stockItemId, keys] of keysByItem) {
    const item = itemMap.get(stockItemId);
    if (!item) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "STOCK_ITEM_MISSING",
        status: "block",
        detail: "Movement/inventory references a stock item that is missing from the stock master",
      });
      continue;
    }

    const derivedTotal = keys.reduce(
      (sum, key) => sum.plus(derivedOpeningByKey.get(key) ?? 0),
      new Decimal(0)
    );
    const masterOpeningQty = repairQuantity(item.opening_qty ?? "0");
    if (derivedTotal.minus(masterOpeningQty).abs().gt(QTY_TOLERANCE)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_QUANTITY_MISMATCH",
        status: "block",
        expected: masterOpeningQty.toFixed(3),
        actual: derivedTotal.toFixed(3),
        detail: `Derived location openings do not sum to stock master opening for ${item.code ?? stockItemId}`,
      });
      continue;
    }

    const openingRate = repairMoney(item.opening_rate ?? "0");
    const openingValue = repairMoney(item.opening_value ?? "0");
    const calculatedOpeningValue = repairMoney(masterOpeningQty.times(openingRate));
    if (calculatedOpeningValue.minus(openingValue).abs().gt(MONEY_TOLERANCE)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_VALUE_MISMATCH",
        status: "block",
        expected: openingValue.toFixed(2),
        actual: calculatedOpeningValue.toFixed(2),
        detail: `Opening quantity × rate does not reconcile to opening value for ${item.code ?? stockItemId}`,
      });
      continue;
    }

    for (const key of keys) {
      const parts = key.split(":");
      const locationId = Number(parts[1]);
      const quantity = derivedOpeningByKey.get(key) ?? new Decimal(0);
      if (quantity.lt(new Decimal(0).minus(QTY_TOLERANCE))) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: "NEGATIVE_DERIVED_OPENING",
          status: "block",
          expected: ">=0.000",
          actual: quantity.toFixed(3),
          detail: "Location opening reconstructed from quantity history is negative",
        });
        continue;
      }
      openings.push({
        companyId,
        locationId,
        stockItemId,
        quantity: repairQuantity(Decimal.max(quantity, 0)).toFixed(3),
        averageRate: openingRate.toFixed(2),
      });
    }

    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "OPENING_QUANTITY_RECONCILED",
      status: "pass",
      expected: masterOpeningQty.toFixed(3),
      actual: derivedTotal.toFixed(3),
    });
  }

  return { openings, checks, derivedOpeningByKey };
}

type RepairBlockerIndex = {
  itemWide: Map<string, RepairCheck>;
  locationSpecific: Map<string, RepairCheck>;
};

function buildRepairBlockerIndex(checks: RepairCheck[]): RepairBlockerIndex {
  const itemWide = new Map<string, RepairCheck>();
  const locationSpecific = new Map<string, RepairCheck>();
  for (const check of checks) {
    if (check.status !== "block" || check.stockItemId === null) continue;
    if (check.locationId === null) {
      const key = `${check.companyId}:${check.stockItemId}`;
      if (!itemWide.has(key)) itemWide.set(key, check);
    } else {
      const key = `${check.companyId}:${check.locationId}:${check.stockItemId}`;
      if (!locationSpecific.has(key)) locationSpecific.set(key, check);
    }
  }
  return { itemWide, locationSpecific };
}

function blockerForProposal(
  blockers: RepairBlockerIndex,
  proposal: Pick<HistoricalSalesRepairProposal, "companyId" | "locationId" | "stockItemId">
): RepairCheck | undefined {
  return (
    blockers.locationSpecific.get(`${proposal.companyId}:${proposal.locationId}:${proposal.stockItemId}`) ??
    blockers.itemWide.get(`${proposal.companyId}:${proposal.stockItemId}`)
  );
}

function distinctBlockedItemLocations(checks: RepairCheck[]): number {
  const keys = new Set<string>();
  for (const check of checks) {
    if (check.status !== "block") continue;
    keys.add(
      `${check.companyId}:${check.locationId === null ? "*" : check.locationId}:${
        check.stockItemId === null ? "*" : check.stockItemId
      }`
    );
  }
  return keys.size;
}

function markAmbiguousTimestampTies(
  companyId: number,
  movements: HistoricalSalesRepairMovement[],
  sales: SaleRow[],
  canonicalStart: Date | null
): RepairCheck[] {
  const checks: RepairCheck[] = [];
  const inboundByKeyTime = new Set<string>();
  for (const movement of movements) {
    if (movement.evidence !== "legacy") continue;
    if (d(movement.quantityDelta).lte(0) || movement.unitCost === null) continue;
    inboundByKeyTime.add(
      `${movement.locationId}:${movement.stockItemId}:${movement.occurredAt}`
    );
  }
  for (const sale of sales) {
    if (!sale.location_id || !beforeCutoff(sale.created_at, canonicalStart)) continue;
    const key = `${sale.location_id}:${sale.stock_item_id}:${iso(sale.created_at)}`;
    if (inboundByKeyTime.has(key)) {
      checks.push({
        companyId,
        locationId: Number(sale.location_id),
        stockItemId: Number(sale.stock_item_id),
        code: "SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS",
        status: "block",
        detail: `Sale item ${sale.sales_item_id} shares an exact legacy timestamp with a priced stock-in; ordering cannot be proven`,
      });
    }
  }
  return checks;
}


const CANONICAL_SALE_SOURCE_TYPES = new Set(["pos-sale", "pos-import", "credit-sales-import"]);

function canonicalMovementId(movement: HistoricalSalesRepairMovement): number {
  const match = movement.movementId.match(/^canonical:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function replaceCanonicalEraSaleProposals(input: {
  companyId: number;
  canonicalStart: Date | null;
  canonicalMovements: HistoricalSalesRepairMovement[];
  sales: SaleRow[];
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
}): HistoricalSalesRepairProposal[] {
  const { companyId, canonicalStart, canonicalMovements, sales, checks } = input;
  if (!canonicalStart) return input.proposals;

  const proposalBySaleId = new Map(input.proposals.map((proposal) => [proposal.salesItemId, proposal]));
  const currentSalesGroups = new Map<string, SaleRow[]>();

  for (const sale of sales) {
    if (beforeCutoff(sale.created_at, canonicalStart) || !sale.location_id) continue;
    const key = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    const group = currentSalesGroups.get(key) ?? [];
    group.push(sale);
    currentSalesGroups.set(key, group);
  }

  const canonicalGroups = new Map<string, HistoricalSalesRepairMovement[]>();
  for (const movement of canonicalMovements) {
    if (!CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType)) continue;
    if (d(movement.quantityDelta).gte(0)) continue;
    const key = `${movement.sourceId}:${movement.locationId}:${movement.stockItemId}`;
    const group = canonicalGroups.get(key) ?? [];
    group.push(movement);
    canonicalGroups.set(key, group);
  }

  for (const [key, saleGroupUnsorted] of currentSalesGroups) {
    const saleGroup = [...saleGroupUnsorted].sort((a, b) => Number(a.sales_item_id) - Number(b.sales_item_id));
    const candidates = [...(canonicalGroups.get(key) ?? [])].sort(
      (a, b) => canonicalMovementId(a) - canonicalMovementId(b)
    );
    const sample = saleGroup[0];
    const locationId = Number(sample.location_id);
    const stockItemId = Number(sample.stock_item_id);

    if (candidates.length < saleGroup.length) {
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "CANONICAL_SALE_EVIDENCE_MISSING",
        status: "block",
        expected: String(saleGroup.length),
        actual: String(candidates.length),
        detail: `Voucher ${sample.voucher_id} does not have enough canonical sale issues to prove current sale-line costs`,
      });
      continue;
    }

    // POS edits append a fresh issue revision after reversing the old one. The
    // current sales_items rows are the latest revision, so pair them with the
    // latest issue set for this voucher/location/item.
    const selected = candidates.slice(candidates.length - saleGroup.length);
    const remaining = [...selected];
    const pairs: Array<{ sale: SaleRow; movement: HistoricalSalesRepairMovement }> = [];
    let pairingFailed = false;

    for (const sale of saleGroup) {
      const saleQty = repairQuantity(sale.quantity).abs();
      const matchIndex = remaining.findIndex((movement) =>
        repairQuantity(movement.quantityDelta).abs().eq(saleQty)
      );
      if (matchIndex < 0) {
        pairingFailed = true;
        break;
      }
      pairs.push({ sale, movement: remaining.splice(matchIndex, 1)[0] });
    }

    if (pairingFailed || pairs.length !== saleGroup.length) {
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "CANONICAL_SALE_EVIDENCE_AMBIGUOUS",
        status: "block",
        expected: saleGroup.map((sale) => repairQuantity(sale.quantity).abs().toFixed(3)).join(","),
        actual: selected.map((movement) => repairQuantity(movement.quantityDelta).abs().toFixed(3)).join(","),
        detail: `Voucher ${sample.voucher_id} canonical sale issues cannot be paired unambiguously to current sale lines`,
      });
      continue;
    }

    for (const { sale, movement } of pairs) {
      const original = proposalBySaleId.get(Number(sale.sales_item_id));
      if (!original) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: "CANONICAL_SALE_PROPOSAL_MISSING",
          status: "block",
          detail: `Sale item ${sale.sales_item_id} was not present in the replay proposal set`,
        });
        continue;
      }

      const proposedCostPrice = repairRate(movement.unitCost ?? "0");
      const proposedTotalCost = repairMoney(d(sale.quantity).abs().times(proposedCostPrice));
      const proposedProfit = repairMoney(d(sale.total_sales).minus(proposedTotalCost));
      proposalBySaleId.set(Number(sale.sales_item_id), {
        ...original,
        occurredAt: movement.occurredAt,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        evidence: "canonical",
        proposedCostPrice: proposedCostPrice.toFixed(2),
        proposedTotalCost: proposedTotalCost.toFixed(2),
        proposedProfit: proposedProfit.toFixed(2),
        changed:
          !repairRate(sale.cost_price).eq(proposedCostPrice) ||
          !repairMoney(sale.total_cost).eq(proposedTotalCost) ||
          !repairMoney(sale.profit).eq(proposedProfit),
      });
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "CANONICAL_SALE_COST_PROVEN",
        status: "pass",
        expected: proposedCostPrice.toFixed(2),
        actual: repairRate(movement.unitCost ?? "0").toFixed(2),
        detail: `Sale item ${sale.sales_item_id} cost is proven by canonical movement ${movement.movementId}`,
      });
    }
  }

  return input.proposals.map((proposal) => proposalBySaleId.get(proposal.salesItemId) ?? proposal);
}

async function dryRunCompany(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<CompanyDryRun> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-sales-cost-repair:${companyId}`]);

  const [inventoryResult, stockItemResult, canonicalStart, sales] = await Promise.all([
    client.query<InventoryRow>(
      `SELECT location_id,stock_item_id,quantity::text,average_rate::text,total_value::text
         FROM inventory
        WHERE company_id=$1
        ORDER BY location_id,stock_item_id`,
      [companyId]
    ),
    client.query<StockItemRow>(
      `SELECT id,code,opening_qty::text,opening_rate::text,opening_value::text
         FROM stock_items
        WHERE company_id=$1
        ORDER BY id`,
      [companyId]
    ),
    loadCanonicalStart(client, companyId, sourceCutoff),
    loadSales(client, companyId, sourceCutoff),
  ]);

  const [canonical, legacy, manual] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
  ]);

  const checks: RepairCheck[] = [...manual.checks];
  const movements: HistoricalSalesRepairMovement[] = [
    ...canonical,
    ...legacy.map((row) => ({
      movementId: row.movement_id,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      sourceType: row.source_type,
      sourceId: row.source_id,
      evidence: "legacy" as const,
    })),
    ...manual.movements.map((row) => ({
      movementId: row.movement_id,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      sourceType: row.source_type,
      sourceId: row.source_id,
      evidence: "legacy" as const,
    })),
  ];

  for (const sale of sales) {
    if (!sale.location_id) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(sale.stock_item_id),
        code: "SALE_LOCATION_MISSING",
        status: "block",
        detail: `Sales item ${sale.sales_item_id} / voucher ${sale.voucher_id} has no location`,
      });
      continue;
    }

    const legacySale = beforeCutoff(sale.created_at, canonicalStart);
    movements.push({
      movementId: `sale-marker:${sale.sales_item_id}`,
      companyId,
      locationId: Number(sale.location_id),
      stockItemId: Number(sale.stock_item_id),
      occurredAt: iso(sale.created_at),
      sequence: Number(sale.sales_item_id) * 10 + (legacySale ? 5 : 6),
      quantityDelta: legacySale ? repairQuantity(d(sale.quantity).negated()).toFixed(3) : "0.000",
      unitCost: null,
      sourceType: legacySale ? "legacy-sale" : "canonical-era-sale-marker",
      sourceId: String(sale.voucher_id),
      evidence: legacySale ? "legacy" : "canonical",
      sale: {
        salesItemId: Number(sale.sales_item_id),
        voucherId: Number(sale.voucher_id),
        quantity: sale.quantity,
        totalSales: sale.total_sales,
        originalCostPrice: sale.cost_price,
        originalTotalCost: sale.total_cost,
        originalProfit: sale.profit,
      },
    });
  }

  checks.push(...markAmbiguousTimestampTies(companyId, movements, sales, canonicalStart));

  const opening = buildOpeningStates({
    companyId,
    stockItems: stockItemResult.rows,
    liveInventory: inventoryResult.rows,
    movements,
  });
  checks.push(...opening.checks);

  const replay = replayHistoricalSalesCosts({ openings: opening.openings, movements });
  const proposals = replaceCanonicalEraSaleProposals({
    companyId,
    canonicalStart,
    canonicalMovements: canonical,
    sales,
    proposals: replay.proposals,
    checks,
  });
  const liveByKey = new Map(
    inventoryResult.rows.map((row) => [
      historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id)),
      row,
    ])
  );
  const replayKeys = new Set([...liveByKey.keys(), ...replay.closingStates.keys()]);
  for (const key of replayKeys) {
    const state = replay.closingStates.get(key);
    const live = liveByKey.get(key);
    const [, locationIdText, stockItemIdText] = key.split(":");
    const expectedQty = repairQuantity(live?.quantity ?? "0");
    const actualQty = repairQuantity(state?.quantity ?? "0");
    if (actualQty.minus(expectedQty).abs().gt(QTY_TOLERANCE)) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CLOSING_QUANTITY_MISMATCH",
        status: "block",
        expected: expectedQty.toFixed(3),
        actual: actualQty.toFixed(3),
        detail: "Forward replay does not reproduce live closing quantity",
      });
      continue;
    }

    const expectedValue = repairMoney(live?.total_value ?? "0");
    const actualValue = repairMoney(state?.totalValue ?? "0");
    if (actualValue.minus(expectedValue).abs().gt(MONEY_TOLERANCE)) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CLOSING_VALUE_MISMATCH",
        status: "block",
        expected: expectedValue.toFixed(2),
        actual: actualValue.toFixed(2),
        detail: "Forward weighted-average replay does not reproduce live closing inventory value",
      });
    } else {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CLOSING_INVENTORY_RECONCILED",
        status: "pass",
        expected: expectedValue.toFixed(2),
        actual: actualValue.toFixed(2),
      });
    }
  }

  const blockers = buildRepairBlockerIndex(checks);
  const report = {
    companyId,
    canonicalStart: canonicalStart ? canonicalStart.toISOString() : null,
    sourceCutoff: sourceCutoff.toISOString(),
    inventoryRows: inventoryResult.rows.length,
    stockItems: stockItemResult.rows.length,
    canonicalMovements: canonical.length,
    legacyMovements: legacy.length + manual.movements.length,
    saleRows: sales.length,
    changedSaleRows: proposals.filter((proposal) => proposal.changed).length,
    blockedItemLocations: distinctBlockedItemLocations(checks),
  };

  return { proposals, checks, report };
}

function proposalHashSource(proposal: HistoricalSalesRepairProposal, status: string, blockerCode?: string | null): string {
  return [
    proposal.salesItemId,
    proposal.voucherId,
    proposal.companyId,
    proposal.locationId,
    proposal.stockItemId,
    proposal.occurredAt,
    proposal.originalCostPrice,
    proposal.originalTotalCost,
    proposal.originalProfit,
    proposal.proposedCostPrice,
    proposal.proposedTotalCost,
    proposal.proposedProfit,
    status,
    blockerCode ?? "",
  ].join("|");
}

async function persistProposalRows(
  client: PoolClient,
  runId: number,
  proposals: HistoricalSalesRepairProposal[],
  checks: RepairCheck[]
): Promise<void> {
  const blockers = buildRepairBlockerIndex(checks);

  const batchSize = 300;
  for (let offset = 0; offset < proposals.length; offset += batchSize) {
    const batch = proposals.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((proposal, index) => {
      const blocked = blockerForProposal(blockers, proposal);
      const status = blocked ? "blocked" : proposal.changed ? "ready" : "unchanged";
      const base = index * 20;
      values.push(
        runId,
        proposal.companyId,
        proposal.locationId,
        proposal.stockItemId,
        proposal.voucherId,
        proposal.salesItemId,
        proposal.occurredAt,
        proposal.evidence,
        proposal.sourceType,
        proposal.sourceId,
        proposal.originalCostPrice,
        proposal.originalTotalCost,
        proposal.originalProfit,
        proposal.proposedCostPrice,
        proposal.proposedTotalCost,
        proposal.proposedProfit,
        proposal.changed,
        status,
        blocked?.code ?? null,
        blocked?.detail ?? null
      );
      const p = Array.from({ length: 20 }, (_, i) => "$" + (base + i + 1));
      return `(${p.join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_rows
       (run_id,company_id,location_id,stock_item_id,voucher_id,sales_item_id,occurred_at,
        evidence,source_type,source_id,original_cost_price,original_total_cost,original_profit,
        proposed_cost_price,proposed_total_cost,proposed_profit,changed,status,blocker_code,
        blocker_detail)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      values
    );
  }
}

async function persistChecks(client: PoolClient, runId: number, checks: RepairCheck[]): Promise<void> {
  const batchSize = 400;
  for (let offset = 0; offset < checks.length; offset += batchSize) {
    const batch = checks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((check, index) => {
      const base = index * 9;
      values.push(
        runId,
        check.companyId,
        check.locationId,
        check.stockItemId,
        check.code,
        check.status,
        check.expected ?? null,
        check.actual ?? null,
        check.detail ?? null
      );
      return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_checks
       (run_id,company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail)
       VALUES ${placeholders.join(",")}`,
      values
    );
  }
}

export type HistoricalSalesCostDryRunResult = {
  runId: number;
  status: "blocked" | "ready";
  auditHash: string;
  sourceCutoff: string;
  totalSalesRows: number;
  changedRows: number;
  blockedRows: number;
  blockedItemLocations: number;
  originalTotalCost: string;
  proposedTotalCost: string;
  originalTotalProfit: string;
  proposedTotalProfit: string;
  companies: Record<string, unknown>[];
};

export async function buildHistoricalSalesCostRepairDryRun(input: {
  createdBy: string;
  companyIds?: number[];
}): Promise<HistoricalSalesCostDryRunResult> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  let runId = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-dry-run'))");

    const cutoffResult = await client.query<{ cutoff: Date }>("SELECT clock_timestamp() AS cutoff");
    const sourceCutoff = cutoffResult.rows[0].cutoff;
    const companyIds = await companyIdsForRun(client, input.companyIds);

    const created = await client.query<{ id: number }>(
      `INSERT INTO historical_sales_cost_repair_runs
       (algorithm_version,status,source_cutoff_at,requested_company_ids,created_by)
       VALUES ($1,'building',$2,$3,$4)
       RETURNING id`,
      [HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION, sourceCutoff, companyIds, input.createdBy]
    );
    runId = Number(created.rows[0].id);

    const companyReports: Record<string, unknown>[] = [];
    const allProposals: HistoricalSalesRepairProposal[] = [];
    const allChecks: RepairCheck[] = [];
    for (const companyId of companyIds) {
      const result = await dryRunCompany(client, companyId, sourceCutoff);
      companyReports.push(result.report);
      allProposals.push(...result.proposals);
      allChecks.push(...result.checks);
    }

    await persistChecks(client, runId, allChecks);
    await persistProposalRows(client, runId, allProposals, allChecks);

    const blockers = buildRepairBlockerIndex(allChecks);
    const blockedRows = allProposals.filter((proposal) => blockerForProposal(blockers, proposal)).length;
    const changedRows = allProposals.filter(
      (proposal) => proposal.changed && !blockerForProposal(blockers, proposal)
    ).length;

    const originalTotalCost = repairMoney(allProposals.reduce((sum, p) => sum.plus(p.originalTotalCost), new Decimal(0)));
    const proposedTotalCost = repairMoney(allProposals.reduce((sum, p) => sum.plus(p.proposedTotalCost), new Decimal(0)));
    const originalTotalProfit = repairMoney(allProposals.reduce((sum, p) => sum.plus(p.originalProfit), new Decimal(0)));
    const proposedTotalProfit = repairMoney(allProposals.reduce((sum, p) => sum.plus(p.proposedProfit), new Decimal(0)));

    const hash = createHash("sha256");
    hash.update(HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION);
    hash.update("|");
    hash.update(sourceCutoff.toISOString());
    for (const proposal of [...allProposals].sort((a, b) => a.salesItemId - b.salesItemId)) {
      const blocked = blockerForProposal(blockers, proposal);
      hash.update("\n");
      hash.update(proposalHashSource(proposal, blocked ? "blocked" : proposal.changed ? "ready" : "unchanged", blocked?.code));
    }
    for (const check of [...allChecks].sort((a, b) =>
      [a.companyId,a.locationId ?? 0,a.stockItemId ?? 0,a.code].join(":").localeCompare(
        [b.companyId,b.locationId ?? 0,b.stockItemId ?? 0,b.code].join(":")
      )
    )) {
      hash.update("\ncheck|");
      hash.update(JSON.stringify(check));
    }
    const auditHash = hash.digest("hex");
    const status: "blocked" | "ready" = allChecks.some((check) => check.status === "block") ? "blocked" : "ready";

    const report = {
      algorithmVersion: HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
      sourceCutoff: sourceCutoff.toISOString(),
      companies: companyReports,
      checks: {
        total: allChecks.length,
        pass: allChecks.filter((check) => check.status === "pass").length,
        warning: allChecks.filter((check) => check.status === "warning").length,
        block: allChecks.filter((check) => check.status === "block").length,
      },
    };

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status=$2,
              completed_at=NOW(),
              audit_hash=$3,
              total_sales_rows=$4,
              changed_rows=$5,
              blocked_rows=$6,
              blocked_item_locations=$7,
              original_total_cost=$8,
              proposed_total_cost=$9,
              original_total_profit=$10,
              proposed_total_profit=$11,
              report=$12::jsonb
        WHERE id=$1`,
      [
        runId,
        status,
        auditHash,
        allProposals.length,
        changedRows,
        blockedRows,
        distinctBlockedItemLocations(allChecks),
        originalTotalCost.toFixed(2),
        proposedTotalCost.toFixed(2),
        originalTotalProfit.toFixed(2),
        proposedTotalProfit.toFixed(2),
        JSON.stringify(report),
      ]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair dry-run complete", {
      module: "historical-sales-cost-repair",
      action: "dry-run",
      runId,
      status,
      auditHash,
      companies: companyIds.length,
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
    });

    return {
      runId,
      status,
      auditHash,
      sourceCutoff: sourceCutoff.toISOString(),
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
      blockedItemLocations: distinctBlockedItemLocations(allChecks),
      originalTotalCost: originalTotalCost.toFixed(2),
      proposedTotalCost: proposedTotalCost.toFixed(2),
      originalTotalProfit: originalTotalProfit.toFixed(2),
      proposedTotalProfit: proposedTotalProfit.toFixed(2),
      companies: companyReports,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (runId) {
      await pool.query(
        `UPDATE historical_sales_cost_repair_runs
            SET status='failed',completed_at=NOW(),error=$2
          WHERE id=$1 AND status='building'`,
        [runId, error instanceof Error ? error.message : String(error)]
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getHistoricalSalesCostRepairRun(runId: number): Promise<Record<string, unknown> | null> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const run = await pool.query(
    `SELECT id,algorithm_version,status,source_cutoff_at,requested_company_ids,created_by,created_at,
            completed_at,applied_by,applied_at,audit_hash,total_sales_rows,changed_rows,blocked_rows,
            blocked_item_locations,original_total_cost,proposed_total_cost,original_total_profit,
            proposed_total_profit,report,error
       FROM historical_sales_cost_repair_runs
      WHERE id=$1`,
    [runId]
  );
  if (!run.rows[0]) return null;

  const blockers = await pool.query(
    `SELECT company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail
       FROM historical_sales_cost_repair_checks
      WHERE run_id=$1 AND status IN ('block','warning')
      ORDER BY company_id,stock_item_id,location_id NULLS FIRST,check_code
      LIMIT 500`,
    [runId]
  );
  return { ...run.rows[0], blockers: blockers.rows };
}

export async function applyHistoricalSalesCostRepair(input: {
  runId: number;
  auditHash: string;
  appliedBy: string;
}): Promise<{ runId: number; appliedRows: number; auditHash: string }> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-apply'))");

    const runResult = await client.query<{
      id: number;
      status: string;
      audit_hash: string;
      algorithm_version: string;
      blocked_rows: number;
    }>(
      `SELECT id,status,audit_hash,algorithm_version,blocked_rows
         FROM historical_sales_cost_repair_runs
        WHERE id=$1
        FOR UPDATE`,
      [input.runId]
    );
    const run = runResult.rows[0];
    if (!run) throw new Error("Historical sales cost repair run not found");
    if (run.algorithm_version !== HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION) {
      throw new Error("Historical sales cost repair algorithm version changed; build a new dry run");
    }
    if (run.status !== "ready") {
      throw new Error(`Historical sales cost repair run ${input.runId} is not ready (status=${run.status})`);
    }
    if (!run.audit_hash || run.audit_hash !== input.auditHash) {
      throw new Error("Historical sales cost repair audit hash mismatch");
    }

    const blockerCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status='block'`,
      [input.runId]
    );
    if (Number(blockerCount.rows[0]?.count ?? 0) !== 0) {
      throw new Error("Historical sales cost repair run contains blockers");
    }

    const drift = await client.query<{ sales_item_id: number }>(
      `SELECT r.sales_item_id
         FROM historical_sales_cost_repair_rows r
         LEFT JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='ready'
          AND (
            si.id IS NULL
            OR si.cost_price IS DISTINCT FROM r.original_cost_price
            OR si.total_cost IS DISTINCT FROM r.original_total_cost
            OR si.profit IS DISTINCT FROM r.original_profit
          )
        ORDER BY r.sales_item_id
        LIMIT 25`,
      [input.runId]
    );
    if (drift.rows.length > 0) {
      throw new Error(
        `Historical sales cost repair refused because target sale rows changed after dry run: ${drift.rows
          .map((row) => row.sales_item_id)
          .join(", ")}`
      );
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applying',applied_by=$2
        WHERE id=$1`,
      [input.runId, input.appliedBy]
    );

    await client.query(
      `INSERT INTO historical_sales_cost_repair_apply_log
       (run_id,company_id,sales_item_id,before_cost_price,before_total_cost,before_profit,
        after_cost_price,after_total_cost,after_profit,applied_by)
       SELECT r.run_id,r.company_id,r.sales_item_id,
              r.original_cost_price,r.original_total_cost,r.original_profit,
              r.proposed_cost_price,r.proposed_total_cost,r.proposed_profit,$2
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      [input.runId, input.appliedBy]
    );

    const updated = await client.query(
      `UPDATE sales_items si
          SET cost_price=r.proposed_cost_price,
              total_cost=r.proposed_total_cost,
              profit=r.proposed_profit
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1
          AND r.status='ready'
          AND r.sales_item_id=si.id
        RETURNING si.id`,
      [input.runId]
    );

    await client.query(
      `UPDATE historical_sales_cost_repair_rows
          SET status='applied',applied_at=NOW()
        WHERE run_id=$1 AND status='ready'`,
      [input.runId]
    );

    const verify = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_rows r
         JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='applied'
          AND (
            si.cost_price IS DISTINCT FROM r.proposed_cost_price
            OR si.total_cost IS DISTINCT FROM r.proposed_total_cost
            OR si.profit IS DISTINCT FROM r.proposed_profit
          )`,
      [input.runId]
    );
    if (Number(verify.rows[0]?.count ?? 0) !== 0) {
      throw new Error("Historical sales cost repair post-apply verification failed");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applied',applied_at=NOW(),completed_at=NOW()
        WHERE id=$1`,
      [input.runId]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair applied", {
      module: "historical-sales-cost-repair",
      action: "apply",
      runId: input.runId,
      auditHash: input.auditHash,
      appliedRows: updated.rowCount ?? 0,
      appliedBy: input.appliedBy,
    });

    return {
      runId: input.runId,
      appliedRows: updated.rowCount ?? 0,
      auditHash: input.auditHash,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
