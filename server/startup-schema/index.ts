/**
 * Startup schema migrations.
 *
 * The idempotent `CREATE TABLE / ALTER TABLE / DO $$ ... $$` statements run once
 * at server boot to bring a database up to the runtime-authoritative schema.
 * `runMigrations()` in server/index.ts iterates this array in order.
 *
 * The statements are grouped into the modules below purely to keep any one file
 * readable. Concatenation order here IS the execution order and must match the
 * original single-array file exactly - tests/startup-schema-integrity.test.ts
 * pins the statement count and a hash of the assembled array to prove it.
 */
import { coreTablesAndColumns } from "./001-core-tables-and-columns";
import { factoryContainerColumns } from "./002-factory-container-columns";
import { rentalAndProductionPlanner } from "./003-rental-and-production-planner";
import { postDeployTables } from "./004-post-deploy-tables";
import { tenantAndPerformanceIndexes } from "./005-tenant-and-performance-indexes";
import { orphanForeignKeyRepairs } from "./005-orphan-fk-repairs";
import { primaryAndForeignKeys } from "./006-primary-and-foreign-keys";
import { schemaCatchupMay2026 } from "./007-schema-catchup-may-2026";
import { posExportsAndDispatch } from "./008-pos-exports-and-dispatch";
import { supplierPartnerAndAi } from "./009-supplier-partner-and-ai";
import { securityNotificationsAndPrecision } from "./010-security-notifications-and-precision";
import { stockTransferRevisionIntegrity } from "./011-stock-transfer-revision-integrity";
import { productionPositions } from "./012-production-positions";
import { baleProductionAttribution } from "./013-bale-production-attribution";
import { productionPositionPlanner } from "./014-production-position-planner";
import { productionBonusPayroll } from "./015-production-bonus-payroll";
import { locationWhatsAppStockReports } from "./016-location-whatsapp-stock-reports";
import { locationWhatsAppStockSchedules } from "./017-location-whatsapp-stock-schedules";
import { locationWhatsAppDeliveryHistory } from "./018-location-whatsapp-delivery-history";
import { stockMergeAuditUserId } from "./019-stock-merge-audit-user-id";
import { v3LoadUserId } from "./020-v3-load-user-id";
import { canonicalStockMovementJournal } from "./021-canonical-stock-movement-journal";
import { tenantControlIntegrityRepairs } from "./022-tenant-control-integrity-repairs";
import { financialOperationRequests } from "./023-financial-operation-requests";
import { stockItemSchemaCatchup } from "./024-stock-item-schema-catchup";
import { insuranceMonthlyAmounts } from "./025-insurance-monthly-amounts";
import { poImportParentCompany } from "./026-po-import-parent-company";
import { factoryStaffTrackingSchema } from "./027-factory-staff-tracking";
import { supplierTrackingDefaultsSchema } from "./028-supplier-tracking-defaults";

export const startupMigrations: string[] = [
  ...coreTablesAndColumns,
  ...factoryContainerColumns,
  ...rentalAndProductionPlanner,
  ...postDeployTables,
  ...tenantAndPerformanceIndexes,
  ...orphanForeignKeyRepairs,
  ...primaryAndForeignKeys,
  ...schemaCatchupMay2026,
  ...posExportsAndDispatch,
  ...supplierPartnerAndAi,
  ...securityNotificationsAndPrecision,
  ...stockTransferRevisionIntegrity,
  ...productionPositions,
  ...baleProductionAttribution,
  ...productionPositionPlanner,
  ...productionBonusPayroll,
  ...locationWhatsAppStockReports,
  ...locationWhatsAppStockSchedules,
  ...locationWhatsAppDeliveryHistory,
  // Last: an ALTER on a table created in 007, so it must run after it.
  ...stockMergeAuditUserId,
  ...v3LoadUserId,
  // References companies, stock_items and locations, so it runs after the core
  // tables that create them.
  ...canonicalStockMovementJournal,
  ...tenantControlIntegrityRepairs,
  ...financialOperationRequests,
  // Re-assert the canonical stock_items tail columns for long-lived databases.
  // PO Import performs full-row stock reads and otherwise fails before parsing.
  ...stockItemSchemaCatchup,
  ...insuranceMonthlyAmounts,
  ...poImportParentCompany,
  ...factoryStaffTrackingSchema,
  ...supplierTrackingDefaultsSchema,
];

// Re-exported so server/index.ts can bootstrap the journal from the module it
// already imports for the ordered pass: the journal has to exist in every
// migration mode, including the production one that skips that pass.
export { ensureCanonicalStockMovementJournal } from "../services/inventory/ensureCanonicalStockMovementJournal";
export { ensureFinancialOperationRequests } from "../services/accounting/ensureFinancialOperationRequests";
