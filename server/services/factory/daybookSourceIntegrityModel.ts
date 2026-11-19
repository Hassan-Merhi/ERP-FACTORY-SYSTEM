// Extracted from ./daybookSourceIntegrity.ts

interface SourceGroup {
  /** All txTypes that map to this source table */
  txTypes: string[];
  /** Actual DB table holding the source record */
  sourceTable: string;
  /** Column for company isolation; null = no company check */
  companyCol: string | null;
  /** Column for soft-delete check; null = hard-delete only */
  deletedAtCol: string | null;
  /**
   * When true: a NULL referenceId is itself invalid (the row is excluded).
   * When false: NULL referenceId rows pass through (legacy entries without an ID).
   */
  requireReferenceId: boolean;
}

/**
 * Canonical source groups.  Each entry produces one SQL integrity condition and
 * one batch-lookup in the legacy filter.
 *
 * NOT included: PAYMENT / RECEIPT / JOURNAL (voucher-backed — handled by the
 * LEFT JOIN on live_voucher in the paginated endpoint and by the validVoucherIds
 * set with live-data enrichment in the legacy endpoint).
 */
export const SOURCE_GROUPS: SourceGroup[] = [
  {
    txTypes: ["PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT", "PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL"],
    sourceTable: "factory_target_bonus_manual_payments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["PRODUCTION_TARGET_BONUS_PAYMENT", "PRODUCTION_TARGET_BONUS_REVERSAL"],
    sourceTable: "factory_target_bonus_payments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT", "PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL"],
    sourceTable: "factory_target_bonus_weekly_payments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["SUPPLIER_FX_TRANSFER"],
    sourceTable: "factory_supplier_fx_transfers",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["SUPPLIER_PAYMENT"],
    sourceTable: "factory_supplier_payments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["PAYROLL_PAYMENT", "PAYROLL_GENERATED"],
    sourceTable: "factory_payrolls",
    companyCol: "company_id",
    deletedAtCol: null,
    // Legacy PAYROLL_GENERATED entries written by payrollCoreRoutes were not given
    // a referenceId (bulk-generate over many workers).  Allow NULL so they stay visible.
    requireReferenceId: false,
  },
  {
    txTypes: ["ADVANCE_GIVEN", "ADVANCE_CASH_UPDATED"],
    sourceTable: "factory_worker_advances",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["ADVANCE_REPAYMENT"],
    sourceTable: "factory_advance_repayments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    // FREIGHT / DUTY / FREIGHT_PAYMENT / OTHER_CHARGE all store the container id
    // as referenceId.  CONTAINER_IMPORT and PURCHASE store the container id too.
    txTypes: ["CONTAINER_IMPORT", "PURCHASE", "FREIGHT", "DUTY", "FREIGHT_PAYMENT", "OTHER_CHARGE"],
    sourceTable: "factory_containers",
    companyCol: "company_id",
    deletedAtCol: "deleted_at",
    requireReferenceId: true,
  },
  {
    txTypes: ["MIX_BATCH_CREATED", "MIX_BATCH_TOPUP"],
    sourceTable: "factory_mix_batches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["INVOICE", "LOADING_CREATED"],
    sourceTable: "customer_orders",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["BALE_PRESSING"],
    sourceTable: "factory_pressing_batches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["WASTE_DISPOSAL"],
    sourceTable: "factory_bale_waste_dispatches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["COMMISSION"],
    sourceTable: "factory_container_commissions",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["OPENING_BALANCE_RAW", "OFFLOAD_RAW_STOCK"],
    sourceTable: "factory_raw_stock",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
];

/** txType → SourceGroup for O(1) lookup */
export const REGISTRY_BY_TXTYPE = new Map<string, SourceGroup>();

/** sourceTable → SourceGroup for batch-query lookup */
export const REGISTRY_BY_TABLE = new Map<string, SourceGroup>();

/**
 * What to write to `reference_table` when a writeDaybookEntry caller omits it.
 * Only covers txTypes where the source table is unambiguously determined by
 * txType alone (i.e., every call site uses the same source table).
 */
export const AUTO_FILL_REF_TABLE: Record<string, string> = {
  PRODUCTION_TARGET_BONUS_PAYMENT: "factory_target_bonus_payments",
  PRODUCTION_TARGET_BONUS_REVERSAL: "factory_target_bonus_payments",
  PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT: "factory_target_bonus_weekly_payments",
  PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL: "factory_target_bonus_weekly_payments",
  SUPPLIER_FX_TRANSFER: "factory_supplier_fx_transfers",
  SUPPLIER_PAYMENT: "factory_supplier_payments",
  PAYROLL_PAYMENT: "factory_payrolls",
  PAYROLL_GENERATED: "factory_payrolls",
  ADVANCE_GIVEN: "factory_worker_advances",
  ADVANCE_CASH_UPDATED: "factory_worker_advances",
  ADVANCE_REPAYMENT: "factory_advance_repayments",
  CONTAINER_IMPORT: "factory_containers",
  PURCHASE: "factory_containers",
  FREIGHT: "factory_containers",
  DUTY: "factory_containers",
  FREIGHT_PAYMENT: "factory_containers",
  OTHER_CHARGE: "factory_containers",
  MIX_BATCH_CREATED: "factory_mix_batches",
  MIX_BATCH_TOPUP: "factory_mix_batches",
  INVOICE: "customer_orders",
  LOADING_CREATED: "customer_orders",
  BALE_PRESSING: "factory_pressing_batches",
  WASTE_DISPOSAL: "factory_bale_waste_dispatches",
  COMMISSION: "factory_container_commissions",
  OPENING_BALANCE_RAW: "factory_raw_stock",
  OFFLOAD_RAW_STOCK: "factory_raw_stock",
};
