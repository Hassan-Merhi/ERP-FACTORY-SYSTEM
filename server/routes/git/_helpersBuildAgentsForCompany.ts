// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import { db } from "../../db";
import {
  agentDeclarantMappings,
  bankAccounts,
  containers,
  ledgerAccounts,
  suppliers,
  voucherEntries,
  vouchers,
} from "../../../shared/schema";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { plusMoney, toMoney } from "../../lib/money";
import { fetchSpGitContainers } from "../../lib/spGitTracking";
import {
  OFFLOADED_STATUSES,
  fifoAllocate,
  type AllocStatus,
  type AllocatedRow,
  type ContainerRow,
  type PreviewRow,
  type WarningCode,
} from "./_helpersFifoAllocate";

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

  // Use the same GIT source projection for Supplier Partner companies.
  // These duty fees are logistics estimates, not voucher entries. Existing
  // ledger matching and FIFO logic below remain the sole settlement logic.
  const spContainers = (await fetchSpGitContainers([cid], { includeOffloaded: true }))
    .filter((row) => !!row.agent?.trim() && Number(row.dutyFee) > 0)
    .map((row) => ({
      id: row.id,
      containerNumber: row.containerNumber,
      companyId: row.companyId,
      numberPlate: row.numberPlate,
      offloadDate: row.offloadDate,
      borderDate: row.borderDate,
      createdAt: row.createdAt,
      transporter: row.transporter,
      location: row.trackingLocation,
      dutyFee: row.dutyFee,
      agent: row.agent,
      status: row.status,
      supplierName: row.supplierName,
      supplierCode: row.supplierCode,
    }));
  const allAgentContainers = [...rawContainers, ...spContainers];
  if (allAgentContainers.length === 0) return [];

  // ── 2. Unique agent names ──
  const uniqueAgents = [...new Set(allAgentContainers.map((r) => r.agent!.trim()).filter(Boolean))];

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

    const rawOB = toMoney(acct.openingBalance).toNumber();
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
      balance = plusMoney(balance, toMoney(e.debitAmount).minus(toMoney(e.creditAmount)));
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
      const bOB = toMoney(bank.openingBalance).toNumber();
      balance += bank.openingBalanceSide === "Cr" ? -bOB : bOB;

      const bankEntries = await db
        .select({ debitAmount: voucherEntries.debitAmount, creditAmount: voucherEntries.creditAmount })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(eq(voucherEntries.bankAccountId, bank.id), eq(vouchers.optional, false), isNull(vouchers.deletedAt))
        );

      for (const e of bankEntries) {
        balance = plusMoney(balance, toMoney(e.debitAmount).minus(toMoney(e.creditAmount)));
      }
    }

    return balance;
  }

  // ── 7. Build per-agent summaries ──
  return Promise.all(
    uniqueAgents.map(async (agentName) => {
      const resolution = resolveAgent(agentName);

      const agentContainers: ContainerRow[] = allAgentContainers
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
          dutyFee: toMoney(r.dutyFee).toNumber(),
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
