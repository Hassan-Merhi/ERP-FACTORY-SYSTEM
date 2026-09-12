/**
 * Shared state and helpers for the Goods-In-Transit (GIT) routes.
 *
 * Extracted verbatim from the former single-file server/routes/gitRoutes.ts.
 * `importUndoStore` is module-level mutable state, so every route module must
 * import it from here rather than keeping a copy of its own.
 */
import multer from "multer";
import path from "path";
import { db } from "../../db";
import {
  containers,
  ledgerAccounts,
  voucherEntries,
  vouchers,
  agentDeclarantMappings,
  suppliers,
  bankAccounts,
} from "../../../shared/schema";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

// ── In-memory undo store for bulk Excel imports ────────────────────────────
// Keyed by importId (UUID). Stores the "before" snapshot so the last import
// can be rolled back. Entries expire after 2 hours to prevent unbounded growth.
export const importUndoStore = new Map<
  string,
  {
    companyId: number;
    createdAt: number;
    changes: Array<{ id: number; containerNumber: string; prevData: Record<string, unknown> }>;
  }
>();
export const UNDO_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export const ALLOWED_EXCEL_MIME = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];
export const ALLOWED_EXCEL_EXT = [".xlsx", ".xls"];

export const gitUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXCEL_MIME.includes(file.mimetype) && ALLOWED_EXCEL_EXT.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
    }
  },
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type WarningCode =
  | "no_open_balance"
  | "ledger_exceeds_containers"
  | "allocation_gap"
  | "fuzzy_match"
  | "no_account_linked";

export type AllocStatus = "Cleared" | "Partially Cleared" | "Open";

export interface ContainerRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  offloadDate: string | null;
  borderDate: string | null;
  createdAt: Date;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  supplierName: string | null;
  supplierCode: string | null;
}

export interface AllocatedRow extends ContainerRow {
  clearedAmount: number;
  remainingAmount: number;
  allocationStatus: AllocStatus;
}

export interface PreviewRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  borderDate: string | null;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  supplierName: string | null;
  supplierCode: string | null;
}

// ─── Container statuses treated as "offloaded / completed" ───────────────────
// These are included in the official FIFO balance allocation.
// All other statuses (OTW, At Port, etc.) go to activePreviewRows.
// DB stores "OFFLOADED" (all-caps) via storage.offloadContainer; keep both casings.
export const OFFLOADED_STATUSES = new Set(["Offloaded", "OFFLOADED", "Closed", "CLOSED", "Completed", "COMPLETED"]);

// ─── FIFO allocation ─────────────────────────────────────────────────────────
// Sort offloaded rows oldest→newest, then walk consuming clearedByPayments.
// Returns three buckets: clearedRows, partialRows (0 or 1), openRows.

// outstanding = amount currently owed to the agent (always a positive number).
// Payments made toward containers = offloadedDutyTotal - outstanding (floored at 0).
// The oldest containers are cleared first (FIFO = first-in-first-out).
export function fifoAllocate(
  offloadedRows: ContainerRow[],
  outstanding: number
): {
  clearedRows: AllocatedRow[];
  partialRows: AllocatedRow[];
  openRows: AllocatedRow[];
} {
  const sorted = [...offloadedRows].sort((a, b) => {
    const oA = a.offloadDate ?? "9999-99-99";
    const oB = b.offloadDate ?? "9999-99-99";
    if (oA !== oB) return oA < oB ? -1 : 1;
    const bA = a.borderDate ?? "9999-99-99";
    const bB = b.borderDate ?? "9999-99-99";
    if (bA !== bB) return bA < bB ? -1 : 1;
    const tA = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const tB = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    if (tA !== tB) return tA - tB;
    return a.id - b.id;
  });

  const offloadedDutyTotal = sorted.reduce((s, r) => s + r.dutyFee, 0);
  // Payments made = total duty – what is still owed. Floored at 0 (can't be negative).
  let toConsume = Math.max(offloadedDutyTotal - outstanding, 0);

  const clearedRows: AllocatedRow[] = [];
  const partialRows: AllocatedRow[] = [];
  const openRows: AllocatedRow[] = [];

  for (const row of sorted) {
    if (toConsume >= row.dutyFee) {
      toConsume -= row.dutyFee;
      clearedRows.push({
        ...row,
        clearedAmount: row.dutyFee,
        remainingAmount: 0,
        allocationStatus: "Cleared",
      });
    } else if (toConsume > 0) {
      const cl = toConsume;
      toConsume = 0;
      partialRows.push({
        ...row,
        clearedAmount: cl,
        remainingAmount: row.dutyFee - cl,
        allocationStatus: "Partially Cleared",
      });
    } else {
      openRows.push({
        ...row,
        clearedAmount: 0,
        remainingAmount: row.dutyFee,
        allocationStatus: "Open",
      });
    }
  }

  return { clearedRows, partialRows, openRows };
}

// ─── Per-company FIFO summary builder ────────────────────────────────────────
// Runs all steps (container fetch → mapping resolution → FIFO allocation)
// for a single company. Called once per company in both single and all-companies
// modes so the logic is never duplicated.
// Read-only: no DB mutations of any kind.

export async function buildAgentsForCompany(cid: number) {
  // ── 1. Containers with non-zero duty ──
  const rawContainers = await db
    .select({
      id: containers.id,
      containerNumber: containers.containerNumber,
      companyId: containers.companyId,
      numberPlate: containers.numberPlate,
      offloadDate: containers.offloadDate,
      borderDate: containers.borderDate,
      createdAt: containers.createdAt,
      transporter: containers.transporter,
      location: containers.trackingLocation,
      dutyFee: containers.dutyFee,
      agent: containers.agent,
      status: containers.status,
      supplierName: suppliers.legalName,
      supplierCode: suppliers.code,
    })
    .from(containers)
    .leftJoin(suppliers, eq(containers.supplierId, suppliers.id))
    .where(
      and(
        eq(containers.companyId, cid),
        isNotNull(containers.agent),
        isNotNull(containers.dutyFee),
        sql`${containers.agent} <> ''`,
        sql`CAST(${containers.dutyFee} AS NUMERIC) > 0`
      )
    );

  if (rawContainers.length === 0) return [];

  // ── 2. Unique agent names ──
  const uniqueAgents = [...new Set(rawContainers.map((r) => r.agent!.trim()).filter(Boolean))];

  // ── 3. Active mappings for this company + global (company_id IS NULL) ──
  const allMappings = await db
    .select()
    .from(agentDeclarantMappings)
    .where(
      and(
        eq(agentDeclarantMappings.active, true),
        or(eq(agentDeclarantMappings.companyId, cid), isNull(agentDeclarantMappings.companyId))
      )
    );

  // ── 4. Ledger accounts for this company ──
  // Also include any account explicitly referenced by the mappings for this company,
  // because an agent may be mapped to an account that lives under a different company ID
  // (e.g. a shared/parent-company agent account).
  const mappedAccountIds = allMappings.map((m) => m.ledgerAccountId).filter((id): id is number => id !== null);

  const allLedgerAccts = await db
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      openingBalance: ledgerAccounts.openingBalance,
      openingBalanceSide: ledgerAccounts.openingBalanceSide,
    })
    .from(ledgerAccounts)
    .where(
      and(
        or(
          eq(ledgerAccounts.companyId, cid),
          mappedAccountIds.length > 0 ? inArray(ledgerAccounts.id, mappedAccountIds) : sql`false`
        ),
        isNull(ledgerAccounts.deletedAt)
      )
    );

  // ── 5. Agent → ledger account resolution ──
  // Priority:
  //   1. Company-specific exact agent_name
  //   2. Company-specific alias
  //   3. Global (company_id IS NULL) exact agent_name
  //   4. Global alias
  //   5. Fuzzy ledger account name (fallback)
  function resolveAgent(agentName: string): {
    accountId: number | null;
    accountName: string | null;
    confidence: "exact" | "fuzzy" | "unmapped";
  } {
    const norm = agentName.trim().toLowerCase();

    const byCompanyName = allMappings.find((m) => m.companyId === cid && m.agentName.trim().toLowerCase() === norm);
    if (byCompanyName?.ledgerAccountId) {
      const acc = allLedgerAccts.find((a) => a.id === byCompanyName.ledgerAccountId);
      if (acc) return { accountId: acc.id, accountName: acc.name, confidence: "exact" };
    }

    const byCompanyAlias = allMappings.find(
      (m) => m.companyId === cid && (m.aliases as string[]).some((al) => al.trim().toLowerCase() === norm)
    );
    if (byCompanyAlias?.ledgerAccountId) {
      const acc = allLedgerAccts.find((a) => a.id === byCompanyAlias.ledgerAccountId);
      if (acc) return { accountId: acc.id, accountName: acc.name, confidence: "exact" };
    }

    const byGlobalName = allMappings.find((m) => m.companyId === null && m.agentName.trim().toLowerCase() === norm);
    if (byGlobalName?.ledgerAccountId) {
      const acc = allLedgerAccts.find((a) => a.id === byGlobalName.ledgerAccountId);
      if (acc) return { accountId: acc.id, accountName: acc.name, confidence: "exact" };
    }

    const byGlobalAlias = allMappings.find(
      (m) => m.companyId === null && (m.aliases as string[]).some((al) => al.trim().toLowerCase() === norm)
    );
    if (byGlobalAlias?.ledgerAccountId) {
      const acc = allLedgerAccts.find((a) => a.id === byGlobalAlias.ledgerAccountId);
      if (acc) return { accountId: acc.id, accountName: acc.name, confidence: "exact" };
    }

    const fuzzy = allLedgerAccts.find((acc) => {
      const an = acc.name.trim().toLowerCase();
      return an.includes(norm) || norm.includes(an);
    });
    if (fuzzy) return { accountId: fuzzy.id, accountName: fuzzy.name, confidence: "fuzzy" };

    return { accountId: null, accountName: null, confidence: "unmapped" };
  }

  // ── 6. Ledger balance for an account ──
  // Dr − Cr movements on top of opening balance (optional=false filters adjustments).
  async function getLedgerBalance(accountId: number): Promise<number> {
    const acct = allLedgerAccts.find((a) => a.id === accountId);
    if (!acct) return 0;

    const rawOB = parseFloat(acct.openingBalance || "0");
    let balance = acct.openingBalanceSide === "Cr" ? -rawOB : rawOB;

    // Ledger voucher entries — no company filter, matches Accounts page behaviour
    const entries = await db
      .select({ debitAmount: voucherEntries.debitAmount, creditAmount: voucherEntries.creditAmount })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(eq(voucherEntries.ledgerAccountId, accountId), eq(vouchers.optional, false), isNull(vouchers.deletedAt))
      );

    for (const e of entries) {
      balance += parseFloat(e.debitAmount || "0") - parseFloat(e.creditAmount || "0");
    }

    // Linked bank accounts — entries stored under bankAccountId, not ledgerAccountId.
    // The Accounts page balance folds these in, so we must too.
    const linkedBanks = await db
      .select({
        id: bankAccounts.id,
        openingBalance: bankAccounts.openingBalance,
        openingBalanceSide: bankAccounts.openingBalanceSide,
      })
      .from(bankAccounts)
      .where(eq(bankAccounts.linkedLedgerId, accountId));

    for (const bank of linkedBanks) {
      const bOB = parseFloat(bank.openingBalance || "0");
      balance += bank.openingBalanceSide === "Cr" ? -bOB : bOB;

      const bankEntries = await db
        .select({ debitAmount: voucherEntries.debitAmount, creditAmount: voucherEntries.creditAmount })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(eq(voucherEntries.bankAccountId, bank.id), eq(vouchers.optional, false), isNull(vouchers.deletedAt))
        );

      for (const e of bankEntries) {
        balance += parseFloat(e.debitAmount || "0") - parseFloat(e.creditAmount || "0");
      }
    }

    return balance;
  }

  // ── 7. Build per-agent summaries ──
  return Promise.all(
    uniqueAgents.map(async (agentName) => {
      const resolution = resolveAgent(agentName);

      const agentContainers: ContainerRow[] = rawContainers
        .filter((r) => r.agent?.trim() === agentName)
        .map((r) => ({
          id: r.id,
          containerNumber: r.containerNumber,
          companyId: r.companyId,
          numberPlate: r.numberPlate ?? null,
          offloadDate: r.offloadDate ?? null,
          borderDate: r.borderDate ?? null,
          createdAt: r.createdAt,
          transporter: r.transporter ?? null,
          location: r.location ?? null,
          dutyFee: parseFloat(r.dutyFee || "0"),
          status: r.status,
          supplierName: r.supplierName ?? null,
          supplierCode: r.supplierCode ?? null,
        }));

      const offloadedContainers = agentContainers.filter((r) => OFFLOADED_STATUSES.has(r.status));
      const activeContainers = agentContainers.filter((r) => !OFFLOADED_STATUSES.has(r.status));

      const containerDutyTotal = agentContainers.reduce((s, r) => s + r.dutyFee, 0);
      const offloadedDutyTotal = offloadedContainers.reduce((s, r) => s + r.dutyFee, 0);

      let ledgerBalance: number | null = null;
      if (resolution.accountId !== null) {
        ledgerBalance = await getLedgerBalance(resolution.accountId);
      }

      const warnings: WarningCode[] = [];
      if (resolution.confidence === "fuzzy") warnings.push("fuzzy_match");
      if (resolution.confidence === "unmapped") warnings.push("no_account_linked");

      let clearedRows: AllocatedRow[] = [];
      let partialRows: AllocatedRow[] = [];
      let openRows: AllocatedRow[] = [];
      let clearedByPayments = 0;
      let openBalance: number | null = null;

      if (ledgerBalance !== null) {
        // outstanding = how much we currently owe the agent.
        // A negative ledger balance is a Cr-heavy (liability) account — standard AP
        // convention: the company owes the agent that amount.
        // A positive ledger balance means Dr-heavy — same "we owe them" interpretation
        // when duty charges are posted as Debit entries.
        // In both cases |ledgerBalance| is the net outstanding amount.
        const outstanding = Math.abs(ledgerBalance);

        if (outstanding === 0) {
          // Fully settled — zero balance means every duty dollar has been paid.
          warnings.push("no_open_balance");
          clearedRows = offloadedContainers.map((r) => ({
            ...r,
            clearedAmount: r.dutyFee,
            remainingAmount: 0,
            allocationStatus: "Cleared" as AllocStatus,
          }));
          clearedByPayments = offloadedDutyTotal;
          openBalance = 0;
        } else if (outstanding > offloadedDutyTotal) {
          // Outstanding exceeds all offloaded duty — there may be extra charges not yet
          // matched to containers, or no containers have been offloaded yet.
          warnings.push("ledger_exceeds_containers");
          openRows = offloadedContainers.map((r) => ({
            ...r,
            clearedAmount: 0,
            remainingAmount: r.dutyFee,
            allocationStatus: "Open" as AllocStatus,
          }));
          clearedByPayments = 0;
          openBalance = outstanding;
        } else {
          // Partial payment — FIFO: oldest containers are cleared first.
          const result = fifoAllocate(offloadedContainers, outstanding);
          clearedRows = result.clearedRows;
          partialRows = result.partialRows;
          openRows = result.openRows;
          clearedByPayments =
            clearedRows.reduce((s, r) => s + r.clearedAmount, 0) + partialRows.reduce((s, r) => s + r.clearedAmount, 0);
          openBalance = outstanding;

          const openSum =
            openRows.reduce((s, r) => s + r.remainingAmount, 0) +
            partialRows.reduce((s, r) => s + r.remainingAmount, 0);
          if (Math.abs(openSum - outstanding) > 0.01) {
            warnings.push("allocation_gap");
          }
        }
      }

      const activePreviewRows: PreviewRow[] = activeContainers
        .filter((r) => !!(r.numberPlate ?? "").trim())
        .map((r) => ({
          id: r.id,
          containerNumber: r.containerNumber,
          companyId: r.companyId,
          numberPlate: r.numberPlate,
          borderDate: r.borderDate,
          transporter: r.transporter,
          location: r.location,
          dutyFee: r.dutyFee,
          supplierName: r.supplierName,
          supplierCode: r.supplierCode,
          status: r.status,
        }));

      return {
        agentName,
        ledgerAccountId: resolution.accountId,
        ledgerAccountName: resolution.accountName,
        matchConfidence: resolution.confidence,
        ledgerBalance,
        containerDutyTotal,
        offloadedDutyTotal,
        clearedByPayments,
        openBalance,
        warnings,
        clearedRows,
        partialRows,
        openRows,
        activePreviewRows,
      };
    })
  );
}
