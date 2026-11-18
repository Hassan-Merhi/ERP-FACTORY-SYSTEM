// Extracted from ./container-plan-shipment.ts to keep that module under the source-size cap.
import type { Request } from "express";
import {
  buildPlanShipmentSummary,
  type ContainerLifecycleStatus,
  type ContainerShipmentState,
  isContainerLifecycleStatus,
} from "@shared/containerShipment";
import type { PlannerQueryable } from "./container-planner-source";

export function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string }>(
    `SELECT id, name FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

type ShipmentRow = {
  container_id: number | string;
  container_name: string;
  position: number | string;
  lifecycle_status: string;
  container_number: string | null;
  carrier: string | null;
  booking_number: string | null;
  vessel_name: string | null;
  destination: string | null;
  etd: string | Date | null;
  eta: string | Date | null;
  planned_qty: number | string;
  assigned_qty: number | string;
  allocated_qty: number | string;
  document_count: number | string;
};

function isoDate(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * One query gives the shipment board everything it needs: lifecycle, carrier
 * details, and the Phase 4/5 readiness counts a forward transition is gated on.
 */
export async function loadShipmentRows(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdateContainerId?: number
): Promise<ShipmentRow[]> {
  if (forUpdateContainerId) {
    await client.query(
      `SELECT id FROM factory_container_plan_containers
       WHERE id = $1 AND plan_id = $2 AND company_id = $3
       FOR UPDATE`,
      [forUpdateContainerId, planId, companyId]
    );
  }

  const result = await client.query<ShipmentRow>(
    `SELECT c.id AS container_id, c.name AS container_name, c.position,
            c.lifecycle_status, c.container_number, c.carrier, c.booking_number,
            c.vessel_name, c.destination, c.etd, c.eta,
            COALESCE((SELECT SUM(l.planned_qty) FROM factory_container_plan_lines l
                      WHERE l.plan_container_id = c.id AND l.company_id = c.company_id), 0)::int AS planned_qty,
            COALESCE((SELECT COUNT(*) FROM factory_container_plan_bales b
                      WHERE b.plan_container_id = c.id AND b.company_id = c.company_id), 0)::int AS assigned_qty,
            COALESCE((SELECT SUM(a.allocated_qty) FROM factory_container_plan_allocations a
                      WHERE a.plan_container_id = c.id AND a.company_id = c.company_id), 0)::int AS allocated_qty,
            COALESCE((SELECT COUNT(*) FROM factory_container_plan_documents d
                      WHERE d.plan_container_id = c.id AND d.company_id = c.company_id), 0)::int AS document_count
     FROM factory_container_plan_containers c
     WHERE c.company_id = $1 AND c.plan_id = $2
     ORDER BY c.position, c.id`,
    [companyId, planId]
  );
  return result.rows;
}

export function toShipmentState(row: ShipmentRow): ContainerShipmentState & {
  containerId: number;
  containerName: string;
  position: number;
  documentCount: number;
} {
  return {
    containerId: Number(row.container_id),
    containerName: String(row.container_name),
    position: Number(row.position),
    lifecycleStatus: (isContainerLifecycleStatus(row.lifecycle_status)
      ? row.lifecycle_status
      : "PLANNED") as ContainerLifecycleStatus,
    containerNumber: row.container_number,
    carrier: row.carrier,
    bookingNumber: row.booking_number,
    vesselName: row.vessel_name,
    destination: row.destination,
    etd: isoDate(row.etd),
    eta: isoDate(row.eta),
    plannedQty: Number(row.planned_qty || 0),
    assignedQty: Number(row.assigned_qty || 0),
    allocatedQty: Number(row.allocated_qty || 0),
    documentCount: Number(row.document_count || 0),
  };
}

export async function buildSummary(client: PlannerQueryable, companyId: number, planId: number) {
  const rows = await loadShipmentRows(client, companyId, planId);
  return buildPlanShipmentSummary(rows.map(toShipmentState));
}
