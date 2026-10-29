/**
 * Phase 7 production-target bonus reporting contract.
 *
 * This is intentionally distinct from legacy manual worker bonuses and
 * position/payroll bonus allocations. Payment status must come from a
 * successfully posted Deposit Expense voucher, not a UI decision.
 *
 * Amounts are USD/company-currency decimal strings at cents. Never add
 * different currencies together or recompute a historical award using today's
 * bale rate, team membership, or targets.
 */
export type ProductionTargetBonusStatus =
  | "DRAFT"
  | "PENDING"
  | "APPROVED"
  | "POSTED"
  | "REJECTED"
  | "VOIDED";

export interface ProductionTargetBonusHistoryRow {
  id: number;
  workerId: number;
  workerNameSnapshot: string;
  workerCodeSnapshot: string | null;
  productionDate: string; // YYYY-MM-DD, the date bales were credited
  currency: string; // ISO 4217 code, e.g. USD
  targetBales: number;
  creditedBales: number;
  excessBales: number;
  bonusPerExtraBale: string; // immutable rate snapshot, up to 4 dp
  amount: string; // immutable awarded/proposed total, 2 dp
  status: ProductionTargetBonusStatus;
  approvedAt: string | null;
  postedAt: string | null;
  paymentVoucherId: number | null;
  paymentVoucherNumber: string | null;
  paymentAccountNameSnapshot: string | null;
  // Source documents can link this to the original daily calculation without
  // relying on current link-team membership or later stock-entry edits.
  productionSnapshotId: string | null;
}

export interface BonusMoneyTotals {
  currency: string;
  pendingProposed: string;
  approvedUnpaid: string;
  paid: string;
  accepted: string; // approvedUnpaid + paid; excludes pending/rejected/voided
  rejected: string;
  draft: string;
  totalRows: number;
  paidCount: number;
  approvedCount: number;
  pendingCount: number;
}

export interface BonusWorkerTotals extends BonusMoneyTotals {
  workerId: number;
  workerName: string;
  workerCode: string | null;
}

export interface ProductionTargetBonusReport {
  start: string;
  end: string;
  rows: ProductionTargetBonusHistoryRow[];
  currencies: BonusMoneyTotals[];
  workers: BonusWorkerTotals[];
  generatedAt: string;
}

/** Safe positive amount in cents: 0.00 to 9,999,999,999,999.99. */
export function bonusMoneyToCents(amount: string): number {
  if (typeof amount !== "string" || !/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/.test(amount)) {
    throw new Error("Invalid bonus amount: require nonnegative decimal with at most two places");
  }
  const [whole, fraction = ""] = amount.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("Bonus amount exceeds safe range");
  return cents;
}

export function bonusCentsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid bonus cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function isBonusReportDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T12:00:00.000Z");
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

type Accumulator = {
  pendingProposed: number; approvedUnpaid: number; paid: number;
  rejected: number; draft: number; totalRows: number;
  paidCount: number; approvedCount: number; pendingCount: number;
};

const empty = (): Accumulator => ({
  pendingProposed: 0, approvedUnpaid: 0, paid: 0, rejected: 0,
  draft: 0, totalRows: 0, paidCount: 0, approvedCount: 0, pendingCount: 0,
});

function add(acc: Accumulator, row: ProductionTargetBonusHistoryRow): void {
  const cents = bonusMoneyToCents(row.amount);
  acc.totalRows++;
  switch (row.status) {
    case "DRAFT": acc.draft += cents; break;
    case "PENDING": acc.pendingProposed += cents; acc.pendingCount++; break;
    case "APPROVED": acc.approvedUnpaid += cents; acc.approvedCount++; break;
    case "POSTED": acc.paid += cents; acc.paidCount++; break;
    case "REJECTED": acc.rejected += cents; break;
    case "VOIDED": break;
    default: throw new Error("Unknown bonus reporting status");
  }
}

function snapshot(currency: string, acc: Accumulator): BonusMoneyTotals {
  return {
    currency,
    pendingProposed: bonusCentsToMoney(acc.pendingProposed),
    approvedUnpaid: bonusCentsToMoney(acc.approvedUnpaid),
    paid: bonusCentsToMoney(acc.paid),
    accepted: bonusCentsToMoney(acc.approvedUnpaid + acc.paid),
    rejected: bonusCentsToMoney(acc.rejected),
    draft: bonusCentsToMoney(acc.draft),
    totalRows: acc.totalRows, paidCount: acc.paidCount,
    approvedCount: acc.approvedCount, pendingCount: acc.pendingCount,
  };
}

/**
 * Report is scoped to awards earned in [start, end]. "Paid" is the CURRENT
 * posting state of those awards, even if their payment happened later.
 * Payment-date cash-flow reporting is intentionally a separate ledger report.
 */
export function buildProductionTargetBonusReport(
  start: string,
  end: string,
  rows: ProductionTargetBonusHistoryRow[],
  generatedAt: string = new Date().toISOString(),
): ProductionTargetBonusReport {
  if (!isBonusReportDate(start) || !isBonusReportDate(end) || end < start) {
    throw new Error("Invalid production bonus report period");
  }

  const seen = new Set<number>();
  const currencies = new Map<string, Accumulator>();
  const workers = new Map<string, { workerId: number; workerName: string; workerCode: string | null; currency: string; totals: Accumulator }>();
  const validated: ProductionTargetBonusHistoryRow[] = [];

  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) {
      throw new Error("Duplicate or invalid bonus award id");
    }
    seen.add(row.id);
    if (!Number.isSafeInteger(row.workerId) || row.workerId <= 0 || !row.workerNameSnapshot.trim()) {
      throw new Error("Bonus award has no valid worker snapshot");
    }
    if (!isBonusReportDate(row.productionDate) || row.productionDate < start || row.productionDate > end) {
      throw new Error("Bonus award is outside requested production dates");
    }
    if (!/^[A-Z]{3}$/.test(row.currency)) throw new Error("Invalid bonus currency");
    if (![row.targetBales, row.creditedBales, row.excessBales].every(n => Number.isFinite(n) && n >= 0)) {
      throw new Error("Invalid bonus bale snapshot");
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(row.bonusPerExtraBale)) {
      throw new Error("Invalid historical bonus rate");
    }
    bonusMoneyToCents(row.amount);
    if (row.status === "POSTED") {
      if (!Number.isSafeInteger(row.paymentVoucherId) || (row.paymentVoucherId ?? 0) <= 0 ||
        !row.postedAt || !row.paymentAccountNameSnapshot?.trim()) {
        throw new Error("Posted bonus lacks verifiable payment voucher/account snapshot");
      }
    } else if (row.paymentVoucherId != null || row.postedAt) {
      throw new Error("Unposted bonus has payment fields");
    }
    validated.push(row);
    if (!currencies.has(row.currency)) currencies.set(row.currency, empty());
    add(currencies.get(row.currency)!, row);
    const key = `${row.workerId}:${row.currency}`;
    let worker = workers.get(key);
    if (!worker) {
      worker = { workerId: row.workerId, workerName: row.workerNameSnapshot,
        workerCode: row.workerCodeSnapshot, currency: row.currency, totals: empty() };
      workers.set(key, worker);
    }
    add(worker.totals, row);
  }

  validated.sort((a, b) => a.productionDate.localeCompare(b.productionDate) ||
    a.workerNameSnapshot.localeCompare(b.workerNameSnapshot) || a.id - b.id);
  return {
    start, end, generatedAt, rows: validated,
    currencies: [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, total]) => snapshot(currency, total)),
    workers: [...workers.values()].map(w => ({ workerId: w.workerId,
      workerName: w.workerName, workerCode: w.workerCode,
      ...snapshot(w.currency, w.totals) }))
      .sort((a, b) => a.workerName.localeCompare(b.workerName) ||
        a.currency.localeCompare(b.currency) || a.workerId - b.workerId),
  };
}
