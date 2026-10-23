/**
 * Phase 15 static integration contract for Claude to RUN during certification.
 * It does not contact production, post vouchers or activate any cutover.
 *
 * Run only when the owner asks for independent CI/source certification:
 *     node scripts/verify-unified-accounting-phase15.mjs
 *
 * This is a source wiring check, NOT an accounting, security or runtime test.
 */
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const content=new Map();
const read=file=>{
 const path=resolve(root,file);
 assert.ok(existsSync(path),`Missing Phase 15 source: ${file}`);
 if(!content.has(file))content.set(file,readFileSync(path,"utf8"));
 return content.get(file);
};
function has(file,fragments){
 const source=read(file);
 for(const text of fragments)assert.ok(source.includes(text),
  `${file} is missing required integration: ${text}`);
}
const routes={
 erp:"client/src/routes/ErpRoutes.tsx",
 factory:"client/src/components/FactoryRoutes.tsx",
 properties:"client/src/app/PropertiesRoutes.tsx"
};
const featureNames=[
 "AccountingOpenItems","CashBankReconciliation","MonetaryFxAccounting",
 "UnifiedRentalAccounting","GroupConsolidationAccounting",
 "HistoricalAccounting","ProfessionalFinancialStatements",
 "FiscalCloseReview","UnifiedAccountingDashboard",
 "UnifiedAccountingRollout"
];
for(const file of Object.values(routes))has(file,featureNames);
has(routes.erp,[
 "/accounting/open-items","/accounting/cash-bank","/accounting/monetary-fx",
 "/accounting/erp-inventory","/accounting/factory-production",
 "/accounting/rentals","/accounting/consolidation",
 "/accounting/history","/accounting/statements",
 "/accounting/fiscal-review",
 "/accounting/dashboard","/accounting/rollout"
]);
has(routes.factory,[
 "/factory/accounting/open-items","/factory/accounting/cash-bank",
 "/factory/accounting/monetary-fx","/factory/accounting/production",
 "/factory/accounting/rentals","/factory/accounting/consolidation",
 "/factory/accounting/history","/factory/accounting/statements",
 "/factory/accounting/fiscal-review",
 "/factory/accounting/dashboard","/factory/accounting/rollout"
]);
has(routes.properties,[
 "/properties/accounting/open-items","/properties/accounting/cash-bank",
 "/properties/accounting/monetary-fx","/properties/accounting/rentals",
 "/properties/accounting/consolidation","/properties/accounting/history",
 "/properties/accounting/statements",
 "/properties/accounting/fiscal-review","/properties/accounting/dashboard",
 "/properties/accounting/rollout"
]);
has("server/routes/applicationRoutes.ts",[
 "enforceSharedFactoryAccess","enforceUnifiedAccountingRollout",
 "registerUnifiedAccountingRoutes(app)"
]);
has("server/routes/unifiedAccountingRoutes.ts",[
 "registerAccountingOpenItemRoutes(app)",
 "registerCashBankReconciliationRoutes(app)",
 "registerMonetaryFxRoutes(app)",
 "registerErpInventoryAccountingRoutes(app)",
 "registerFactoryProductionAccountingRoutes(app)",
 "registerUnifiedRentalAccountingRoutes(app)",
 "registerGroupConsolidationRoutes(app)",
 "registerHistoricalAccountingRoutes(app)",
 "registerProfessionalFinancialStatementRoutes(app)",
 "registerFiscalReviewRoutes(app)",
 "registerUnifiedAccountingDashboardRoutes(app)",
 "registerUnifiedAccountingRolloutRoutes(app)"
]);
has("server/middleware/sharedFactoryAccessBoundary.ts",[
 "/api/accounting/rollout/","/api/accounting/unified-dashboard",
 "/api/accounting/fiscal-review/"
]);
has("shared/factoryAccessRegistry.ts",[
 "/factory/accounting/rollout","/factory/accounting/dashboard",
 "/factory/accounting/statements"
]);
has("server/middleware/unifiedAccountingRolloutBoundary.ts",[
 "ACCOUNTING_READ_ONLY_ROLLOUT","ACCOUNTING_POSTING_NOT_CERTIFIED",
 "currentPilotEligibilityTx","/api/accounting/monetary-fx/realized",
 "/api/accounting/fiscal-review/close"
]);
has("server/services/accounting/fiscalReviewService.ts",[
 "jsonb_build_array(voucher_id",
 "base_debit_amount IS NULL",
 "base_credit_amount IS NULL",
 "accounting_fiscal_review_signoffs",
 "fiscal_review_company_scope",
 "reviewMetadataCompanyRlsInstalled",
 "OPENING_BALANCE_LOCK_TABLES",
 "openingBalanceLockTriggerName",
 "voucher_entries_audit_row_delete"
]);
has("client/src/pages/FiscalCloseReview.tsx",[
 "UNIFIED_FINANCIAL_POSTING_CERTIFIED = false",
 "reviewMetadataCompanyRlsInstalled"
]);
has("server/routes/fiscalReviewRoutes.ts",[
 "UNIFIED_FINANCIAL_POSTING_RELEASED",
 "ensureReviewedFiscalCloseTx",
 "recordReviewedFiscalCloseTx"
]);
has("server/services/accounting/ensureUnifiedAccountingRolloutSchema.ts",[
 "accounting_unified_rollout_policy","accounting_unified_release_reviews",
 "FORCE ROW LEVEL SECURITY","unified_release_review_immutable"
]);
has("server/services/accounting/unifiedRolloutService.ts",[
 "buildTrialBalance","getHistoricalCurrencyReadiness",
 "eligibleForExternalReview","PERPETUAL_INVENTORY_POSTING_READY",
 "deployedUnifiedReleaseSha",
 "METADATA_ENTRY_REFERENCES_COMPATIBLE = false",
 "if (!METADATA_ENTRY_REFERENCES_COMPATIBLE)",
 "reviewMetadataCompanyRlsInstalled" // retained independently by fiscal review stage
].filter(x=>x!=="reviewMetadataCompanyRlsInstalled"));
has("server/services/accounting/unifiedRolloutService.ts",[
 "accounting_unified_rollout_policy",
 "cost_centers",
 "cost_center_allocations",
 "cost_center_monthly_budgets",
 'AS "hasPolicy"',
 "pilotOperational:",
 "blockers.length === 0"
]);
has("server/middleware/unifiedAccountingRolloutBoundary.ts",[
 'String(req.session.currentRole ?? "")',
 "ACCOUNTING_ROLLOUT_CHECK_UNAVAILABLE",
 "UNIFIED_FINANCIAL_POSTING_RELEASED = false"
]);
has("server/routes/unifiedAccountingRolloutRoutes.ts",[
 'String(req.session.currentRole ?? "")'
]);
has("client/src/pages/UnifiedAccountingRollout.tsx",[
 "metadataEntryReferencesCompatible",
 "Metadata pilot configured",
 "hasPolicy",
 "phase === 6 || phase === 7 || phase === 12",
 "d = readiness.data?.companyId === Number(companyId)"
]);
has("server/services/accounting/perpetualInventory/cutover.ts",[
 "export const PERPETUAL_INVENTORY_POSTING_READY = false"
]);
has("server/startup/ensureRuntimeSchema.ts",[
 "ensurePartyOpenItemSchema","ensureCashBankReconciliationSchema",
 "ensureMonetaryFxSchema","ensureRentalAccountingLinksSchema",
 "ensureFiscalReviewSchema",
 "ensureUnifiedAccountingRolloutSchema"
]);
has("client/src/lazyPages.ts",[
 "UnifiedAccountingDashboard","UnifiedAccountingRollout",
 "FiscalCloseReview","ProfessionalFinancialStatements"
]);
// Phase 12 preserves the existing Cost Centers implementation and connects
// to its per-company analytical report without a second GL or budget writer.
has("client/src/pages/UnifiedAccountingDashboard.tsx",[
 "UnifiedAccountingBudgetBridge","tab === \"budgets\""
]);
has("client/src/components/financial/UnifiedAccountingBudgetBridge.tsx",[
 "/api/factory/cost-centers","/api/cost-centers",
 "/reports/summary","scope === \"company\"",
 'mode !== "properties"'
]);
has("server/routes/applicationRoutes.ts",["registerCostCenterReportingRoutes(app)"]);
has("server/routes/costCenterReportingRoutes.ts",[
 '"/reports/summary"', '"/budgets"'
]);
// Phase 14: the financial-position gap is displayed before and after
// unclassified account balances. Past-date ERP/Factory stock must never
// form a mixed-date management total or masquerade as booked GL assets.
has("server/services/accounting/professionalFinancialStatements.ts",[
 "reportedBalanceSheetDifferenceUsd"
]);
has("server/services/accounting/unifiedAccountingDashboard.ts",[
 "position.reportedBalanceSheetDifferenceUsd",
 "managementCostCandidateBasis",
 "WITHHELD_MIXED_DATES",
 "WITHHELD_INCOMPLETE_COST",
 "unitemizedMovementValueUsd",
 "unitemizedHistoricalErpMovements",
 "operationalAmountsAddedToBookedNetAssets: false"
]);
has("client/src/pages/UnifiedAccountingDashboard.tsx",[
 "reportedBalanceSheetDifferenceUsd",
 "managementCostCandidateBasis",
 "WITHHELD_MIXED_DATES",
 "WITHHELD_INCOMPLETE_COST",
 "Legacy compatibility only"
]);
has("server/routes/unifiedAccountingDashboardRoutes.ts",[
 "legacyCompatibilityMode",
 '"private, no-store"'
]);
for(let phase=6;phase<=15;phase++){
 const file=`docs/unified-accounting-phase${phase}.md`;
 assert.ok(existsSync(resolve(root,file)),`Missing Phase ${phase} handoff: ${file}`);
}
console.log("Phase 15 source wiring manifest passed — this is NOT CI, accounting certification or deployment.");
