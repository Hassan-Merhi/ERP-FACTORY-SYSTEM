// Extracted from ./companyImportRoutes.ts: a stage of companyImportRoutes.
import {
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryDailyUsages,
  factoryPressingBatches,
  factoryBales,
  factoryContainerCommissions,
  customerProformas,
  customerProformaLines,
  customerInvoiceSequences,
  factoryDaybookEntries,
  factoryDaybookEntryEdits,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerDocuments,
  factoryAlerts,
  factoryWasteEntries,
  factoryBalePhotos,
} from "@shared/schema";
import type { companyImportRoutesStep } from "./companyImportRoutesStep";
import type { companyImportRoutesStep2 } from "./companyImportRoutesStep2";

type CompanyImportRoutesStepResult = Awaited<ReturnType<typeof companyImportRoutesStep>>;
type CompanyImportRoutesStep2Result = Awaited<ReturnType<typeof companyImportRoutesStep2>>;

export async function companyImportRoutesStep3({
  ci1,
  ci2,
}: {
  ci1: Extract<CompanyImportRoutesStepResult, { done: false }>;
  ci2: CompanyImportRoutesStep2Result;
}) {
  const { insertAndMap } = ci2;
  const { t } = ci1;

  if (t.factory_containers?.length) {
    await insertAndMap("factory_containers", factoryContainers, t.factory_containers, {
      supplierId: "factory_suppliers",
      freightAccountId: "ledger_accounts",
      otherChargesAccountId: "ledger_accounts",
      dutyAccountId: "ledger_accounts",
    });
  }

  if (t.factory_raw_stock?.length) {
    await insertAndMap("factory_raw_stock", factoryRawStock, t.factory_raw_stock, {
      containerId: "factory_containers",
    });
  }

  if (t.factory_container_commissions?.length) {
    await insertAndMap("factory_container_commissions", factoryContainerCommissions, t.factory_container_commissions, {
      containerId: "factory_containers",
      ledgerAccountId: "ledger_accounts",
    });
  }

  if (t.factory_offload_additional_charges?.length) {
    await insertAndMap(
      "factory_offload_additional_charges",
      factoryOffloadAdditionalCharges,
      t.factory_offload_additional_charges,
      {
        containerId: "factory_containers",
        ledgerAccountId: "ledger_accounts",
      }
    );
  }

  if (t.factory_duty_audit_log?.length) {
    await insertAndMap(
      "factory_duty_audit_log",
      factoryDutyAuditLog,
      t.factory_duty_audit_log,
      {
        containerId: "factory_containers",
      },
      { nullifyFields: ["updatedByUserId"] }
    );
  }

  if (t.factory_mix_batches?.length) {
    await insertAndMap("factory_mix_batches", factoryMixBatches, t.factory_mix_batches, {
      carryForwardFromId: "factory_mix_batches",
    });
  }

  if (t.factory_mix_batch_sources?.length) {
    await insertAndMap(
      "factory_mix_batch_sources",
      factoryMixBatchSources,
      t.factory_mix_batch_sources,
      {
        mixBatchId: "factory_mix_batches",
        containerId: "factory_containers",
        supplierId: "factory_suppliers",
        sourceBatchId: "factory_mix_batches",
      },
      { hasCompanyId: false }
    );
  }

  if (t.factory_daily_usages?.length) {
    await insertAndMap("factory_daily_usages", factoryDailyUsages, t.factory_daily_usages, {
      mixBatchId: "factory_mix_batches",
    });
  }

  if (t.factory_pressing_batches?.length) {
    await insertAndMap(
      "factory_pressing_batches",
      factoryPressingBatches,
      t.factory_pressing_batches,
      {
        mixBatchId: "factory_mix_batches",
        productId: "factory_bale_products",
        finalizedLocationId: "locations",
      },
      { nullifyFields: ["createdBy"] }
    );
  }

  if (t.factory_bales?.length) {
    await insertAndMap(
      "factory_bales",
      factoryBales,
      t.factory_bales,
      {
        mixBatchId: "factory_mix_batches",
        productId: "factory_bale_products",
        pressingBatchId: "factory_pressing_batches",
        erpLocationId: "locations",
      },
      { nullifyFields: ["finalizedBy"] }
    );
  }

  if (t.factory_workers?.length) {
    await insertAndMap("factory_workers", factoryWorkers, t.factory_workers, {});
  }

  if (t.factory_payrolls?.length) {
    await insertAndMap(
      "factory_payrolls",
      factoryPayrolls,
      t.factory_payrolls,
      {
        workerId: "factory_workers",
        cashAccountId: "ledger_accounts",
      },
      { nullifyFields: ["approvedBy"] }
    );
  }

  if (t.factory_worker_documents?.length) {
    await insertAndMap("factory_worker_documents", factoryWorkerDocuments, t.factory_worker_documents, {
      workerId: "factory_workers",
    });
  }

  if (t.factory_daybook_entries?.length) {
    await insertAndMap(
      "factory_daybook_entries",
      factoryDaybookEntries,
      t.factory_daybook_entries,
      {},
      { nullifyFields: ["createdBy"] }
    );
  }

  if (t.factory_daybook_entry_edits?.length) {
    await insertAndMap(
      "factory_daybook_entry_edits",
      factoryDaybookEntryEdits,
      t.factory_daybook_entry_edits,
      {
        daybookEntryId: "factory_daybook_entries",
      },
      { hasCompanyId: false, nullifyFields: ["editedBy"] }
    );
  }

  if (t.factory_waste_entries?.length) {
    await insertAndMap(
      "factory_waste_entries",
      factoryWasteEntries,
      t.factory_waste_entries,
      {
        mixBatchId: "factory_mix_batches",
        supplierId: "factory_suppliers",
        containerId: "factory_containers",
      },
      { nullifyFields: ["createdBy"] }
    );
  }

  if (t.factory_bale_photos?.length) {
    await insertAndMap(
      "factory_bale_photos",
      factoryBalePhotos,
      t.factory_bale_photos,
      {
        baleId: "factory_bales",
      },
      { nullifyFields: ["uploadedBy"] }
    );
  }

  if (t.factory_alerts?.length) {
    await insertAndMap("factory_alerts", factoryAlerts, t.factory_alerts, {});
  }

  if (t.customer_proformas?.length) {
    await insertAndMap("customer_proformas", customerProformas, t.customer_proformas, {
      customerId: "customers",
    });
  }

  if (t.customer_proforma_lines?.length) {
    await insertAndMap(
      "customer_proforma_lines",
      customerProformaLines,
      t.customer_proforma_lines,
      {
        proformaId: "customer_proformas",
      },
      { hasCompanyId: false }
    );
  }

  if (t.customer_invoice_sequences?.length) {
    await insertAndMap("customer_invoice_sequences", customerInvoiceSequences, t.customer_invoice_sequences, {});
  }
}
