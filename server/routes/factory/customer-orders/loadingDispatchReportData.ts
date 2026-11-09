/**
 * Read-only Factory truck dispatch reporting.
 *
 * Open/reopened trips: current loading vs verified evidence.
 * Closed trips: use frozen close-time comparison AND frozen bale manifest.
 * Never substitute newer scanner data for a signed historical report.
 */
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import {
  compareFactoryLoadingDispatch,
  type ComparisonScan,
  type ComparisonTrip,
  type LoadingDispatchComparison,
} from "./loadingDispatchComparison";
import { loadFactoryLoadingDispatchComparisonSnapshot } from "./loadingDispatchComparisonRoutes";

export type DispatchReportSource = "LIVE" | "CLOSURE";
export interface DispatchReportTrip {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
  driverName: string | null;
  destination: string | null;
  notes: string | null;
  containerNumberSnapshot: string | null;
  createdByUsername: string | null;
  createdAt: string | null;
  closedAt: string | null;
  closedByUsername: string | null;
}
export interface DispatchReportClosure {
  id: string;
  revision: number;
  fingerprint: string;
  closedAt: string;
  closedByUsername: string;
  approvedWithDiscrepancies: boolean;
  discrepancyReason: string | null;
  reopenedAt: string | null;
  reopenedByUsername: string | null;
  reopenReason: string | null;
}
export interface DispatchReportAudit {
  id: string;
  dispatchId: string;
  eventType: string;
  actorUsername: string;
  createdAt: string;
  details: Record<string, unknown>;
}
export interface DispatchReport {
  source: DispatchReportSource;
  generatedAt: string;
  loading: {
    orderId: number;
    companyName: string;
    customerName: string | null;
    proformaName: string | null;
    containerNumber: string | null;
    status: string;
  };
  trip: DispatchReportTrip | null;
  closure: DispatchReportClosure | null;
  comparison: LoadingDispatchComparison;
  scans: ComparisonScan[];
  manifestAvailable: boolean;
  notices: string[];
  audit: DispatchReportAudit[];
  auditTruncated: boolean;
}

type Raw = Record<string, unknown>;
const results = (r: unknown): Raw[] => resultRows(r);
const str = (v: unknown) => v == null ? "" : String(v);
const nullable = (v: unknown) => v == null ? null : String(v);
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export class DispatchReportError extends Error {
  constructor(readonly httpStatus: number, readonly code: string, message: string) { super(message); }
}

export async function loadFactoryDispatchReport(input: {
  companyId: number;
  orderId: number;
  dispatchId?: number;
  closureId?: number;
}): Promise<DispatchReport> {
  return db.transaction(async (tx) => {
    // One consistent snapshot prevents summary, articles and manifests
    // from describing different moments while two scanners are active.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const snapshot = await loadFactoryLoadingDispatchComparisonSnapshot(
      tx, input.companyId, input.orderId, input.dispatchId
    );
    if (!snapshot) {
      throw new DispatchReportError(404, "LOADING_NOT_FOUND", "Loading not found in the active company");
    }
    if ("notFoundTrip" in snapshot) {
      throw new DispatchReportError(404, "DISPATCH_NOT_FOUND", "Dispatch not found for this loading");
    }

    const metadataRows = results(await tx.execute(sql`
      SELECT co.id, co.status, co.container_number AS "containerNumber",
             c.legal_name AS "customerName", p.name AS "proformaName",
             cmp.name AS "companyName"
        FROM customer_orders co
        LEFT JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
        LEFT JOIN customer_proformas p ON p.id = co.proforma_id_used AND p.company_id = co.company_id
        JOIN companies cmp ON cmp.id = co.company_id
       WHERE co.company_id = ${input.companyId} AND co.id = ${input.orderId}
       LIMIT 1
    `));
    const meta = metadataRows[0];
    if (!meta) throw new DispatchReportError(404, "LOADING_NOT_FOUND", "Loading not found");

    const tripRows = results(await tx.execute(sql`
      SELECT id, dispatch_number AS "dispatchNumber", status,
             truck_plate AS "truckPlate", driver_name AS "driverName",
             destination, notes,
             container_number_snapshot AS "containerNumberSnapshot",
             created_by_username AS "createdByUsername",
             created_at AS "createdAt", closed_at AS "closedAt",
             closed_by_user_id AS "closedByUserId"
        FROM factory_loading_dispatches
       WHERE company_id = ${input.companyId} AND order_id = ${input.orderId}
       ORDER BY dispatch_number
    `));
    const selected = input.dispatchId === undefined ? null :
      tripRows.find((t) => str(t.id) === String(input.dispatchId)) ?? null;
    if (input.dispatchId !== undefined && !selected) {
      throw new DispatchReportError(404, "DISPATCH_NOT_FOUND", "Trip not found for this loading");
    }

    const toTrip = (t: Raw): DispatchReportTrip => ({
      id: str(t.id), dispatchNumber: num(t.dispatchNumber), status: str(t.status),
      truckPlate: nullable(t.truckPlate), driverName: nullable(t.driverName),
      destination: nullable(t.destination), notes: nullable(t.notes),
      containerNumberSnapshot: nullable(t.containerNumberSnapshot),
      createdByUsername: nullable(t.createdByUsername),
      createdAt: iso(t.createdAt), closedAt: iso(t.closedAt),
      closedByUsername: null,
    });
    let trip = selected ? toTrip(selected) : null;

    const notices: string[] = [];
    let source: DispatchReportSource = "LIVE";
    let closure: DispatchReportClosure | null = null;
    let frozenComparison: LoadingDispatchComparison | null = null;
    let frozenScans: ComparisonScan[] | null = null;
    let manifestAvailable = true;

    if (input.closureId !== undefined && !selected) {
      throw new DispatchReportError(400, "CLOSURE_REQUIRES_TRIP", "A historical closure must specify its truck");
    }
    if (selected && (str(selected.status) === "CLOSED" || input.closureId !== undefined)) {
      const closeRows = results(await tx.execute(sql`
        SELECT id, revision, close_fingerprint AS "fingerprint",
               comparison_snapshot AS "comparison",
               manifest_snapshot AS "manifest", truck_snapshot AS "truck",
               closed_at AS "closedAt", closed_by_username AS "closedByUsername",
               approved_with_discrepancies AS "approvedWithDiscrepancies",
               discrepancy_reason AS "discrepancyReason",
               reopened_at AS "reopenedAt",
               reopened_by_username AS "reopenedByUsername",
               reopen_reason AS "reopenReason"
          FROM factory_loading_dispatch_closure_history
         WHERE company_id = ${input.companyId} AND order_id = ${input.orderId}
           AND dispatch_id = ${input.dispatchId!}
           AND (${input.closureId ?? null}::bigint IS NULL OR id = ${input.closureId ?? null})
         ORDER BY revision DESC LIMIT 1
      `));
      const record = closeRows[0];
      if (!record) {
        throw new DispatchReportError(404, "CLOSURE_NOT_FOUND", "No matching completed dispatch report exists");
      }
      source = "CLOSURE";
      closure = {
        id: str(record.id), revision: num(record.revision),
        fingerprint: str(record.fingerprint), closedAt: iso(record.closedAt) ?? "",
        closedByUsername: str(record.closedByUsername),
        approvedWithDiscrepancies: record.approvedWithDiscrepancies === true,
        discrepancyReason: nullable(record.discrepancyReason),
        reopenedAt: iso(record.reopenedAt), reopenedByUsername: nullable(record.reopenedByUsername),
        reopenReason: nullable(record.reopenReason),
      };
      frozenComparison = record.comparison as LoadingDispatchComparison;
      if (!frozenComparison || !frozenComparison.summary || !Array.isArray(frozenComparison.articles)) {
        throw new DispatchReportError(409, "CLOSURE_SNAPSHOT_UNAVAILABLE", "This historical comparison is incomplete");
      }
      // Historical trip metadata must come from the closure, not from a later
      // re-edit. Phase 7+ closures capture the full truck detail snapshot.
      const oldTruck = record.truck && typeof record.truck === "object" &&
        !Array.isArray(record.truck) ? record.truck as Raw : null;
      if (oldTruck && trip) {
        trip = {
          ...trip, dispatchNumber: num(oldTruck.dispatchNumber),
          truckPlate: nullable(oldTruck.truckPlate),
          driverName: nullable(oldTruck.driverName),
          destination: nullable(oldTruck.destination), notes: nullable(oldTruck.notes),
          containerNumberSnapshot: nullable(oldTruck.containerNumberSnapshot),
          createdByUsername: nullable(oldTruck.createdByUsername),
          createdAt: iso(oldTruck.createdAt),
          status: "CLOSED", closedAt: closure.closedAt,
          closedByUsername: closure.closedByUsername,
        };
      } else {
        notices.push("This closure predates saved truck metadata. Current truck details may have changed.");
        if (trip) trip = { ...trip, status: "CLOSED", closedAt: closure.closedAt,
          closedByUsername: closure.closedByUsername };
      }
      if (Array.isArray(record.manifest)) {
        frozenScans = record.manifest.map((row: unknown) => {
          const s = row && typeof row === "object" ? row as Raw : {};
          return {
            scanId: str(s.scanId), baleId: num(s.baleId),
            baleReference: str(s.baleReference), articleCode: str(s.articleCode),
            productName: str(s.productName), weightKg: num(s.weightKg),
            dispatchId: String(input.dispatchId), dispatchNumber: trip?.dispatchNumber ?? 0,
            scannedBy: str(s.scannedByUsername), scannedAt: iso(s.scannedAt) ?? "",
          };
        });
      } else {
        // Do not misrepresent live rows as an archived manifest.
        frozenScans = [];
        manifestAvailable = false;
        notices.push("Bale-level historical manifest was not saved for this earlier closure. Its historical item comparison remains available.");
      }
    }

    const comparison = frozenComparison ?? compareFactoryLoadingDispatch({
      loaded: snapshot.loaded, scans: snapshot.scans,
      expectedBales: snapshot.expectedBales, expectedArticles: snapshot.expectedArticles,
      trips: snapshot.trips,
      ...(selected ? { selectedDispatchId: String(selected.id) } : {}),
    });

    const scans = frozenScans ?? (selected
      ? snapshot.scans.filter((s) => s.dispatchId === str(selected.id))
      : snapshot.scans).slice().sort((a, b) =>
      a.scannedAt.localeCompare(b.scannedAt) || a.scanId.localeCompare(b.scanId));

    // The activity log is contextual, not a replacement for historical
    // closure evidence. Limit large exports explicitly and disclose it.
    const auditRows = results(await tx.execute(sql`
      SELECT id, dispatch_id AS "dispatchId", event_type AS "eventType",
             actor_username AS "actorUsername", created_at AS "createdAt",
             event_data AS "details"
        FROM factory_loading_dispatch_events
       WHERE company_id = ${input.companyId} AND order_id = ${input.orderId}
         AND (${input.dispatchId ?? null}::bigint IS NULL OR dispatch_id = ${input.dispatchId ?? null})
       ORDER BY id DESC
       LIMIT 10001
    `));
    const auditTruncated = auditRows.length > 10000;
    const audit = auditRows.slice(0, 10000).map((r): DispatchReportAudit => ({
      id: str(r.id), dispatchId: str(r.dispatchId), eventType: str(r.eventType),
      actorUsername: str(r.actorUsername), createdAt: iso(r.createdAt) ?? "",
      details: r.details && typeof r.details === "object" && !Array.isArray(r.details)
        ? r.details as Record<string, unknown> : {},
    }));
    if (auditTruncated) notices.push("Activity sheet contains the 10,000 most recent events only.");

    if (source === "LIVE") notices.push("Live verification report; its counts may change until the truck dispatch is ended.");
    if (closure?.reopenedAt) notices.push("Historical closure was later reopened. This report represents the earlier signed revision.");
    return {
      source, generatedAt: new Date().toISOString(),
      loading: {
        orderId: input.orderId, companyName: str(meta.companyName),
        customerName: nullable(meta.customerName), proformaName: nullable(meta.proformaName),
        containerNumber: nullable(meta.containerNumber), status: str(meta.status),
      },
      trip, closure, comparison, scans,
      manifestAvailable, notices, audit, auditTruncated,
    };
  });
}
