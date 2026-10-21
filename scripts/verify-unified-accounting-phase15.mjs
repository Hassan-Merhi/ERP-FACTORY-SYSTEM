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
import {resolve} from "node:path";
const root=resolve(import.meta.dirname??new URL("..",import.meta.url).pathname,"..");
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
 "CostCenterAccounting","FiscalCloseReview","UnifiedAccountingDashboard",
 "UnifiedAccountingRollout"
];
for(const file of Object.values(routes))has(file,featureNames);
has(routes.erp,[
 "/accounting/open-items","/accounting/cash-bank","/accounting/monetary-fx",
 "/accounting/erp-inventory","/accounting/factory-production",
 "/accounting/rentals","/accounting/consolidation",
 "/accounting/history","/accounting/statements",
 "/accounting/cost-centers","/accounting/fiscal-review",
 "/accounting/dashboard","/accounting/rollout"
]);
has(routes.factory,[
 "/factory/accounting/open-items","/factory/accounting/cash-bank",
 "/factory/accounting/monetary-fx","/factory/accounting/production",
 "/factory/accounting/rentals","/factory/accounting/consolidation",
 "/factory/accounting/history","/factory/accounting/statements",
 "/factory/accounting/cost-centers","/factory/accounting/fiscal-review",
 "/factory/accounting/dashboard","/factory/accounting/rollout"
]);
has(routes.properties,[
 "/properties/accounting/open-items","/properties/accounting/cash-bank",
 "/properties/accounting/monetary-fx","/properties/accounting/rentals",
 "/properties/accounting/consolidation","/properties/accounting/history",
 "/properties/accounting/statements","/properties/accounting/cost-centers",
 "/properties/accounting/fiscal-review","/properties/accounting/dashboard",
 "/properties/accounting/rollout"
]);
has("server/routes/applicationRoutes.ts",[
 "enforceSharedFactoryAccess","enforceUnifiedAccountingRollout",
 "registerAccountingOpenItemRoutes(app)",
 "registerCashBankReconciliationRoutes(app)",
 "registerMonetaryFxRoutes(app)",
 "registerErpInventoryAccountingRoutes(app)",
 "registerFactoryProductionAccountingRoutes(app)",
 "registerUnifiedRentalAccountingRoutes(app)",
 "registerGroupConsolidationRoutes(app)",
 "registerHistoricalAccountingRoutes(app)",
 "registerProfessionalFinancialStatementRoutes(app)",
 "registerAnalyticAccountingRoutes(app)",
 "registerFiscalReviewRoutes(app)",
 "registerUnifiedAccountingDashboardRoutes(app)",
 "registerUnifiedAccountingRolloutRoutes(app)"
]);
has("server/middleware/sharedFactoryAccessBoundary.ts",[
 "/api/accounting/rollout/","/api/accounting/unified-dashboard",
 "/api/accounting/analytics/","/api/accounting/fiscal-review/"
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
has("server/services/accounting/ensureUnifiedAccountingRolloutSchema.ts",[
 "accounting_unified_rollout_policy","accounting_unified_release_reviews",
 "FORCE ROW LEVEL SECURITY","unified_release_review_immutable"
]);
has("server/services/accounting/unifiedRolloutService.ts",[
 "buildTrialBalance","getHistoricalCurrencyReadiness",
 "eligibleForExternalReview","PERPETUAL_INVENTORY_POSTING_READY",
 "deployedUnifiedReleaseSha","phaseCatalog"
].filter(x=>x!=="phaseCatalog"));
has("server/services/accounting/perpetualInventory/cutover.ts",[
 "export const PERPETUAL_INVENTORY_POSTING_READY = false"
]);
has("server/startup/ensureRuntimeSchema.ts",[
 "ensurePartyOpenItemSchema","ensureCashBankReconciliationSchema",
 "ensureMonetaryFxSchema","ensureRentalAccountingLinksSchema",
 "ensureAnalyticAccountingSchema","ensureFiscalReviewSchema",
 "ensureUnifiedAccountingRolloutSchema"
]);
has("client/src/lazyPages.ts",[
 "UnifiedAccountingDashboard","UnifiedAccountingRollout",
 "FiscalCloseReview","CostCenterAccounting","ProfessionalFinancialStatements"
]);
for(let phase=6;phase<=15;phase++){
 const file=`docs/unified-accounting-phase${phase}.md`;
 assert.ok(existsSync(resolve(root,file)),`Missing Phase ${phase} handoff: ${file}`);
}
console.log("Phase 15 source wiring manifest passed — this is NOT CI, accounting certification or deployment.");
