/**
 * Read/write logistics-only overlay for Supplier Partner containers in the
 * same GIT UI used by ERP. SP source records and posted vouchers are untouched.
 * Synthetic negative ids distinguish SP containers from ERP container ids.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { resultRows } from "./queryResult";
import type { RawContainerRow } from "./gitHelpers";

export const SP_GIT_STATUSES = ["OTW", "Sea", "At Port", "Left Dar", "At Border", "In Transit", "Arrived"] as const;
export const SP_GIT_FIELDS = [
  "shopName", "eta", "transporter", "transportFee", "numberPlate", "trackingLocation",
  "borderDate", "agent", "dutyFee", "docReceived", "trackingDescription", "blDocs",
  "docsSentDate", "trackingLink", "freightStatus",
] as const;
export type SpGitField = (typeof SP_GIT_FIELDS)[number];

/** Exactly one small logistics table; this does not change stock/accounting. */
let ensurePromise: Promise<void> | null = null;
export function ensureSpGitTracking(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sp_container_git_tracking (
          container_id integer PRIMARY KEY REFERENCES sp_containers(id) ON DELETE CASCADE,
          company_id integer NOT NULL,
          status varchar(24),
          shop_name text,
          eta date,
          transporter text,
          transport_fee numeric(20,4),
          number_plate text,
          tracking_location text,
          border_date date,
          agent text,
          duty_fee numeric(20,4),
          doc_received boolean,
          tracking_description text,
          bl_docs text,
          docs_sent_date date,
          tracking_link text,
          freight_status text,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`ALTER TABLE sp_container_git_tracking ADD COLUMN IF NOT EXISTS freight_status text`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sp_container_git_tracking_company_idx
        ON sp_container_git_tracking(company_id)`);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

const str = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

type SpGitDbRow = {
  id: number; company_id: number; container_number: string | null;
  supplier_name: string | null; status: string; invoice_date: string;
  invoice_total_usd: string; freight_estimate_usd: string | null;
  created_at: string | Date; shop_name: string | null; eta: string | null;
  transporter: string | null; transport_fee: string | null;
  number_plate: string | null; tracking_location: string | null; border_date: string | null;
  agent: string | null; duty_fee: string | null; doc_received: boolean | null;
  tracking_description: string | null; bl_docs: string | null; docs_sent_date: string | null;
  tracking_link: string | null; freight_status: string | null; logistics_status: string | null;
};

export async function fetchSpGitContainers(
  companyIds: number[],
  options: { includeOffloaded?: boolean; containerId?: number } = {},
): Promise<RawContainerRow[]> {
  if (companyIds.length === 0 || (options.containerId !== undefined && options.containerId > 0)) return [];
  const ids = sql.join(companyIds.map((id) => sql`${id}`), sql`, `);
  // Do not run SP schema DDL in ordinary ERP tracking requests that have
  // zero Supplier Partner containers. Legacy ERP queries stay read-only.
  const presence = await db.execute(sql`
    SELECT 1 FROM sp_containers WHERE company_id IN (${ids}) LIMIT 1
  `);
  if (resultRows(presence).length === 0) return [];
  await ensureSpGitTracking();
  const idCondition = options.containerId && options.containerId < 0
    ? sql`AND s.id = ${-options.containerId}`
    : sql``;
  const statusCondition = options.includeOffloaded ? sql`AND s.status <> 'cancelled'` : sql`AND s.status = 'open'`;
  const response = await db.execute(sql`
    SELECT s.id, s.company_id, s.container_number, s.supplier_name, s.status,
      s.invoice_date, s.invoice_total_usd, s.freight_estimate_usd, s.created_at,
      t.status AS logistics_status, t.shop_name, t.eta, t.transporter, t.transport_fee,
      t.number_plate, t.tracking_location, t.border_date, t.agent, t.duty_fee,
      t.doc_received, t.tracking_description, t.bl_docs, t.docs_sent_date, t.tracking_link, t.freight_status
    FROM sp_containers s
    LEFT JOIN sp_container_git_tracking t ON t.container_id = s.id AND t.company_id = s.company_id
    WHERE s.company_id IN (${ids})
      ${statusCondition}
      ${idCondition}
    ORDER BY s.container_number
  `);
  return resultRows<SpGitDbRow>(response).map((row) => {
    const isOffloaded = row.status === "offloaded";
    return {
      id: -Number(row.id),
      companyId: Number(row.company_id),
      containerNumber: str(row.container_number) || `SP-${row.id}`,
      supplierId: 0,
      supplierName: str(row.supplier_name),
      supplierCode: str(row.supplier_name),
      status: isOffloaded ? "OFFLOADED" : (
        SP_GIT_STATUSES.includes(row.logistics_status as (typeof SP_GIT_STATUSES)[number])
          ? row.logistics_status! : "OTW"
      ),
      importDate: String(row.invoice_date),
      grandTotal: String(row.invoice_total_usd),
      itemName: null,
      shopName: str(row.shop_name),
      eta: str(row.eta)?.slice(0, 10) ?? null,
      etaSource: null,
      transporter: str(row.transporter),
      transportFee: str(row.transport_fee),
      numberPlate: str(row.number_plate),
      trackingLocation: str(row.tracking_location),
      borderDate: str(row.border_date)?.slice(0, 10) ?? null,
      offloadDate: null,
      agent: str(row.agent),
      dutyFee: str(row.duty_fee),
      docReceived: row.doc_received,
      trackingDescription: str(row.tracking_description),
      blDocs: str(row.bl_docs),
      docsSentDate: str(row.docs_sent_date)?.slice(0, 10) ?? null,
      freightStatus: str(row.freight_status),
      trackingLink: str(row.tracking_link),
      poFreight: str(row.freight_estimate_usd) || "0",
      trackingProvider: null,
      trackingEnabled: false,
      trackingAutoUpdate: false,
      trackingCarrierHint: null,
      trackingLastCheckedAt: null,
      trackingLastStatus: null,
      trackingLastLocation: null,
      trackingLastEventDate: null,
      trackingLastDescription: null,
      trackingError: null,
      trackingChangedAt: null,
      trackingDetectedCarrier: null,
      trackingFallbackUsed: null,
      trackingFallbackReason: null,
      trackingNextCheckAt: null,
      trackingLastSkipReason: null,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    };
  });
}
