import Decimal from "decimal.js";

import {
  auditPhase3Accounting,
  Phase3AccountingAuditError,
  type Phase3AccountingAuditInput,
  type Phase3AccountingAuditReport,
  type Phase3AuditIssue,
} from "./phase3AccountingAudit";

export interface DuplicateVoucherEvidence {
  signature: string;
  voucherIds: number[];
}

export interface SupplierReconciliationEvidence {
  supplierId: number;
  statementBalance: string;
  counterpartyBalance: string;
}

export interface IntercompanyReconciliationEvidence {
  transferId: number;
  fromCompanyId: number;
  toCompanyId: number;
  transferAmount: string;
  fromVoucherAmount: string;
  toVoucherAmount: string;
}

export interface HistoricalReconciliationCorruptionInput extends Phase3AccountingAuditInput {
  duplicateVouchers?: DuplicateVoucherEvidence[];
  supplierBalances?: SupplierReconciliationEvidence[];
  intercompanyBalances?: IntercompanyReconciliationEvidence[];
}

export type HistoricalReconciliationAuditDomain = Phase3AuditIssue["domain"] | "suppliers" | "intercompany";

export interface HistoricalReconciliationAuditIssue {
  domain: HistoricalReconciliationAuditDomain;
  identity: string;
  code: string;
  expected: string;
  actual: string;
}

export interface HistoricalReconciliationCorruptionReport
  extends Omit<Phase3AccountingAuditReport, "issues" | "checked"> {
  issues: HistoricalReconciliationAuditIssue[];
  checked: Phase3AccountingAuditReport["checked"] & {
    duplicateVoucherGroups: number;
    supplierBalances: number;
    intercompanyBalances: number;
  };
}

const MONEY_TOLERANCE = new Decimal("0.005");

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Phase3AccountingAuditError("PHASE29_ID_INVALID", `phase29_id_invalid:${field}`);
  }
  return parsed;
}

function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value ?? ""));
    if (!parsed.isFinite()) throw new Error("not_finite");
    return parsed;
  } catch {
    throw new Phase3AccountingAuditError("PHASE29_DECIMAL_INVALID", `phase29_decimal_invalid:${field}`);
  }
}

function addIssue(
  issues: HistoricalReconciliationAuditIssue[],
  domain: HistoricalReconciliationAuditDomain,
  identity: string,
  code: string,
  expected: Decimal | string,
  actual: Decimal | string
): void {
  issues.push({
    domain,
    identity,
    code,
    expected: expected instanceof Decimal ? expected.toFixed() : expected,
    actual: actual instanceof Decimal ? actual.toFixed() : actual,
  });
}

function compareMoney(
  issues: HistoricalReconciliationAuditIssue[],
  domain: HistoricalReconciliationAuditDomain,
  identity: string,
  code: string,
  expected: Decimal,
  actual: Decimal
): void {
  if (expected.minus(actual).abs().gte(MONEY_TOLERANCE)) {
    addIssue(issues, domain, identity, code, expected, actual);
  }
}

/**
 * Phase 29 corruption audit.
 *
 * The established Phase 3 audit remains authoritative for voucher balance,
 * payment/cash, sales/inventory, payroll/Daybook and stock/accounting checks.
 * This wrapper adds historical evidence that must be supplied by the caller
 * when reconciling duplicate voucher identities, supplier statements and
 * mirrored intercompany transfer pairs.
 */
export function auditHistoricalReconciliationCorruption(
  input: HistoricalReconciliationCorruptionInput
): HistoricalReconciliationCorruptionReport {
  const base = auditPhase3Accounting(input);
  const issues: HistoricalReconciliationAuditIssue[] = [...base.issues];
  const duplicateVouchers = input.duplicateVouchers ?? [];
  const supplierBalances = input.supplierBalances ?? [];
  const intercompanyBalances = input.intercompanyBalances ?? [];

  for (const duplicate of duplicateVouchers) {
    const voucherIds = duplicate.voucherIds.map((id, index) =>
      positiveInteger(id, `duplicateVoucher.voucherIds[${index}]`)
    );
    const uniqueVoucherIds = [...new Set(voucherIds)];
    if (uniqueVoucherIds.length <= 1) continue;

    addIssue(
      issues,
      "invariants",
      `voucher-group:${duplicate.signature}`,
      "DUPLICATE_VOUCHER",
      "unique_voucher",
      `${uniqueVoucherIds.length}:${uniqueVoucherIds.join(",")}`
    );
  }

  for (const supplier of supplierBalances) {
    const supplierId = positiveInteger(supplier.supplierId, "supplier.supplierId");
    const statementBalance = decimal(supplier.statementBalance, `supplier:${supplierId}.statementBalance`);
    const counterpartyBalance = decimal(
      supplier.counterpartyBalance,
      `supplier:${supplierId}.counterpartyBalance`
    );
    compareMoney(
      issues,
      "suppliers",
      `supplier:${supplierId}`,
      "SUPPLIER_RECONCILIATION_MISMATCH",
      statementBalance,
      counterpartyBalance
    );
  }

  for (const transfer of intercompanyBalances) {
    const transferId = positiveInteger(transfer.transferId, "intercompany.transferId");
    const fromCompanyId = positiveInteger(transfer.fromCompanyId, `intercompany:${transferId}.fromCompanyId`);
    const toCompanyId = positiveInteger(transfer.toCompanyId, `intercompany:${transferId}.toCompanyId`);
    const identity = `intercompany:${transferId}`;

    if (fromCompanyId === toCompanyId) {
      addIssue(
        issues,
        "intercompany",
        identity,
        "INTERCOMPANY_COMPANY_PAIR_INVALID",
        "distinct_company_pair",
        String(fromCompanyId)
      );
      continue;
    }

    const transferAmount = decimal(transfer.transferAmount, `${identity}.transferAmount`);
    const fromVoucherAmount = decimal(transfer.fromVoucherAmount, `${identity}.fromVoucherAmount`);
    const toVoucherAmount = decimal(transfer.toVoucherAmount, `${identity}.toVoucherAmount`);

    compareMoney(
      issues,
      "intercompany",
      identity,
      "INTERCOMPANY_SOURCE_AMOUNT_MISMATCH",
      transferAmount,
      fromVoucherAmount
    );
    compareMoney(
      issues,
      "intercompany",
      identity,
      "INTERCOMPANY_DESTINATION_AMOUNT_MISMATCH",
      transferAmount,
      toVoucherAmount
    );
    compareMoney(
      issues,
      "intercompany",
      identity,
      "INTERCOMPANY_MIRROR_MISMATCH",
      fromVoucherAmount,
      toVoucherAmount
    );
  }

  return {
    companyId: base.companyId,
    clean: issues.length === 0,
    issues,
    checked: {
      ...base.checked,
      duplicateVoucherGroups: duplicateVouchers.length,
      supplierBalances: supplierBalances.length,
      intercompanyBalances: intercompanyBalances.length,
    },
  };
}
