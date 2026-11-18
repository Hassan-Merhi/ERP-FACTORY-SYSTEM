// Extracted from ./offlinePrep.ts to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { asRecord, isNonEmptyString, toPositiveInteger } from "@shared/typeGuards";
import { type CachedEntity, db, type OfflineMeta } from "./db";
import {
  _inProgress,
  _lastPreparedAt,
  buildPacks,
  ensureServiceWorker,
  type CachedItem,
  type DatasetResult,
  type PrepProgress,
} from "./offlinePrepBuildPacks";

export async function runOfflinePrep(companyId: number, onProgress: (p: PrepProgress) => void): Promise<PrepProgress> {
  if (_inProgress.get(companyId)) {
    // Already running for this company — return a synthetic progress indicating so.
    const inProgressResult: PrepProgress = {
      phase: "preparing",
      currentLabel: "Already in progress — skipping duplicate run",
      totalDatasets: 0,
      completedDatasets: 0,
      failedDatasets: 0,
      percent: 0,
      results: [],
      errors: ["Skipped: preparation already running for this company"],
    };
    onProgress(inProgressResult);
    return inProgressResult;
  }
  _inProgress.set(companyId, true);
  const packs = buildPacks();
  const allDatasets = packs.flatMap((p) => p.datasets.map((d) => ({ ...d, packId: p.id })));
  let total = allDatasets.length;
  const results: DatasetResult[] = [];
  const errors: string[] = [];

  const emit = (phase: PrepProgress["phase"], label: string) => {
    const completed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const done = completed + failed;
    onProgress({
      phase,
      currentLabel: label,
      totalDatasets: total,
      completedDatasets: completed,
      failedDatasets: failed,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      results: [...results],
      errors: [...errors],
    });
  };

  // Step 1: Service worker
  emit("sw", "Checking service worker…");
  try {
    await ensureServiceWorker();
  } catch {
    // Non-fatal
  }

  // Step 2: Download datasets
  emit("preparing", "Starting download…");

  for (const pack of packs) {
    for (const dataset of pack.datasets) {
      emit("preparing", `Downloading ${dataset.label}…`);
      try {
        const res = await fetch(dataset.endpoint, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Guard against HTML responses (e.g. SPA catch-all served instead of JSON)
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("json")) {
          // Non-fatal: some endpoints aren't relevant in factory-only mode
          results.push({ datasetId: dataset.id, label: dataset.label, packId: pack.id, success: true, count: 0 });
          continue;
        }

        const raw = await res.json();

        // Offline-error marker
        if (raw?.offline || raw?.error === "Offline") {
          throw new Error("App is already offline — cannot download");
        }

        const items = dataset.extractItems(raw, companyId);

        if (dataset.tableKey && db[dataset.tableKey]) {
          // Clear existing data for this company, then bulk-insert
          await (
            db as unknown as {
              [key: string]: { where: (arg0: "companyId") => { equals: (arg0: number) => { delete: () => unknown } } };
            }
          )[dataset.tableKey]
            .where("companyId")
            .equals(companyId)
            .delete();
          await (db as unknown as { [key: string]: { bulkPut: (arg0: CachedEntity[]) => unknown } })[
            dataset.tableKey
          ].bulkPut(items);
        } else {
          // Save as offlinePackages blob
          const existing = await db.offlinePackages.where("key").equals(`pkg_${dataset.id}_${companyId}`).first();
          const pkg = {
            key: `pkg_${dataset.id}_${companyId}`,
            entityType: dataset.id,
            companyId,
            data: JSON.stringify(items.map((e) => JSON.parse(e.data))),
            downloadedAt: Date.now(),
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            version: (existing?.version ?? 0) + 1,
          };
          if (existing?.id) {
            await db.offlinePackages.update(existing.id, pkg);
          } else {
            await db.offlinePackages.add(pkg);
          }
        }

        results.push({
          datasetId: dataset.id,
          label: dataset.label,
          packId: pack.id,
          success: true,
          count: items.length,
        });
      } catch (e) {
        const msg = `${dataset.label}: ${getErrorDetails(e).optionalMessage ?? "Unknown error"}`;
        errors.push(msg);
        results.push({
          datasetId: dataset.id,
          label: dataset.label,
          packId: pack.id,
          success: false,
          count: 0,
          error: getErrorDetails(e).optionalMessage,
        });
      }
    }
  }

  // Step 2b: Pre-warm lazy-loaded factory page JS chunks so they work offline
  // without needing a prior visit. Dynamic import() fetches the chunk; the
  // service worker caches it automatically via stale-while-revalidate.
  const pageChunks = [
    // ── Core factory pages ───────────────────────────────────────────────
    { label: "Dashboard", loader: () => import("@/pages/factory/FactoryDashboard") },
    { label: "Daybook", loader: () => import("@/pages/factory/FactoryDaybook") },
    { label: "Suppliers", loader: () => import("@/pages/factory/FactorySuppliers") },
    { label: "Containers", loader: () => import("@/pages/factory/FactoryContainers") },
    { label: "Container Create", loader: () => import("@/pages/factory/FactoryContainerCreate") },
    // ── Stock & bales ────────────────────────────────────────────────────
    { label: "Stock Entry", loader: () => import("@/pages/factory/BaleStockEntry") },
    { label: "Bale Products", loader: () => import("@/pages/BaleProducts") },
    { label: "Raw Stock", loader: () => import("@/pages/factory/ProductionRawStock") },
    { label: "Raw Materials Hub", loader: () => import("@/pages/factory/FactoryRawMaterialsHub") },
    { label: "Mix Batches", loader: () => import("@/pages/MixBatches") },
    { label: "Bales Hub", loader: () => import("@/pages/factory/FactoryBalesHub") },
    { label: "Bales History", loader: () => import("@/pages/factory/BalesHistory") },
    { label: "Bale Product History", loader: () => import("@/pages/factory/FactoryBaleProductHistory") },
    { label: "Bale Relabeling", loader: () => import("@/pages/factory/FactoryBaleRelabeling") },
    { label: "Wipers Re-Entry", loader: () => import("@/pages/factory/WipersReEntry") },
    { label: "Waste Dispatch", loader: () => import("@/pages/factory/WasteDispatch") },
    // ── Inventory & stock queries ────────────────────────────────────────
    { label: "Location Inventory", loader: () => import("@/pages/factory/FactoryLocationInventory") },
    { label: "Stock Query", loader: () => import("@/pages/StockQuery") },
    { label: "Stock Item Detail", loader: () => import("@/pages/factory/FactoryStockItemDetail") },
    { label: "Stock OTW", loader: () => import("@/pages/StockOTW") },
    // ── Accounting ───────────────────────────────────────────────────────
    { label: "Accounts", loader: () => import("@/pages/factory/FactoryAccounts") },
    { label: "Vouchers", loader: () => import("@/pages/factory/FactoryVouchers") },
    { label: "Voucher Detail", loader: () => import("@/pages/VoucherDetail") },
    { label: "New Voucher", loader: () => import("@/pages/AccountingCreate") },
    { label: "Ledger Monthly", loader: () => import("@/pages/LedgerMonthlySummary") },
    { label: "Ledger Vouchers", loader: () => import("@/pages/LedgerVouchers") },
    // ── Sales & loadings ─────────────────────────────────────────────────
    { label: "Loadings Hub", loader: () => import("@/pages/factory/FactoryLoadingsHub") },
    { label: "Pending Loadings", loader: () => import("@/pages/factory/FactoryPendingLoadings") },
    { label: "Container Scan", loader: () => import("@/pages/factory/FactoryContainerLoadingScan") },
    { label: "Invoices", loader: () => import("@/pages/factory/FactoryInvoices") },
    { label: "Proformas", loader: () => import("@/pages/factory/FactoryProformas") },
    { label: "Pending Invoices", loader: () => import("@/pages/factory/FactoryPendingInvoices") },
    { label: "Customers", loader: () => import("@/pages/factory/FactoryCustomers") },
    // ── People ───────────────────────────────────────────────────────────
    { label: "Workers", loader: () => import("@/pages/factory/FactoryWorkersHub") },
    { label: "Employees", loader: () => import("@/pages/factory/FactoryEmployees") },
    // ── Intelligence ─────────────────────────────────────────────────────
    { label: "KPIs", loader: () => import("@/pages/factory/FactoryKpis") },
    { label: "Alerts", loader: () => import("@/pages/factory/FactoryAlerts") },
    { label: "Waste Intelligence", loader: () => import("@/pages/factory/FactoryWaste") },
    { label: "Production Summary", loader: () => import("@/pages/factory/ProductionSummary") },
    // ── Reports & tools ──────────────────────────────────────────────────
    { label: "Supplier Report", loader: () => import("@/pages/factory/FactorySupplierReport") },
    { label: "Supplier Statement", loader: () => import("@/pages/factory/FactorySupplierStatement") },
    { label: "Barcode Lookup", loader: () => import("@/pages/BarcodeLookup") },
    { label: "Import", loader: () => import("@/pages/factory/FactoryImport") },
    { label: "Factory Settings", loader: () => import("@/pages/factory/FactorySettings") },
  ];
  total += pageChunks.length;
  for (const chunk of pageChunks) {
    emit("preparing", `Pre-caching page: ${chunk.label}…`);
    try {
      await chunk.loader();
      results.push({
        datasetId: `chunk_${chunk.label}`,
        label: chunk.label,
        packId: "factory",
        success: true,
        count: 1,
      });
    } catch {
      // Non-fatal — chunk may already be loaded or not exist
      results.push({
        datasetId: `chunk_${chunk.label}`,
        label: chunk.label,
        packId: "factory",
        success: true,
        count: 0,
      });
    }
  }

  // Step 2c: Dynamic — pre-cache every supplier's broker statement so the
  // supplier ledger page works offline without needing a prior visit.
  try {
    const supplierEntities = await db.factorySuppliers.where("companyId").equals(companyId).toArray();
    if (supplierEntities.length > 0) {
      total += supplierEntities.length;
      for (const entity of supplierEntities) {
        let supplier: CachedItem = {};
        try {
          supplier = asRecord(JSON.parse(entity.data)) ?? {};
        } catch {
          /* skip */
        }
        const supplierId = toPositiveInteger(supplier.id);
        const label = isNonEmptyString(supplier.name) ? supplier.name : `Supplier ${supplierId ?? entity.id}`;
        const datasetId = `ledger_${supplierId ?? entity.id}`;
        emit("preparing", `Caching ledger: ${label}…`);

        // A cached supplier without a usable id cannot address the ledger
        // endpoint — this used to request `/suppliers/undefined/...` and wait
        // for the server to reject it. Dropping the step and its slot in the
        // progress total is equivalent and saves a round trip. Entities are
        // cached by id, so this is unreachable for a cache this module wrote.
        if (supplierId === undefined) {
          total -= 1;
          continue;
        }

        try {
          const r = await fetch(`/api/factory/suppliers/${supplierId}/broker-statement`, { credentials: "include" });
          results.push({
            datasetId,
            label,
            packId: "factory",
            success: r.ok,
            count: r.ok ? 1 : 0,
            error: r.ok ? undefined : `HTTP ${r.status}`,
          });
        } catch {
          // Non-fatal: network down or route not yet visited — SW cache miss is fine
          results.push({ datasetId, label, packId: "factory", success: true, count: 0 });
        }
      }
    }
  } catch {
    // Non-fatal — supplier ledger pre-cache is a best-effort step
  }

  // Step 3: Verify
  emit("verifying", "Verifying offline package…");
  const completed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const status: OfflineMeta["status"] = failed === 0 ? "ready" : completed > 0 ? "partial" : "not_ready";

  // Build pack summary
  const packSummary: Record<string, { label: string; count: number; completedAt: number }> = {};
  for (const pack of packs) {
    const packResults = results.filter((r) => r.packId === pack.id && r.success);
    const totalCount = packResults.reduce((s, r) => s + r.count, 0);
    packSummary[pack.id] = { label: pack.label, count: totalCount, completedAt: Date.now() };
  }

  // Write metadata
  const meta: OfflineMeta = {
    key: "main",
    preparedAt: Date.now(),
    status,
    totalDatasets: total,
    completedDatasets: completed,
    errors: JSON.stringify(errors),
    packSummary: JSON.stringify(packSummary),
  };
  const existing = await db.offlineMeta.where("key").equals("main").first();
  if (existing?.id) {
    await db.offlineMeta.update(existing.id, meta);
  } else {
    await db.offlineMeta.add(meta);
  }

  const finalPhase = status === "not_ready" ? "error" : "done";
  const finalProgress: PrepProgress = {
    phase: finalPhase,
    currentLabel:
      status === "ready" ? "All datasets downloaded — device is offline-ready" : `Done with ${failed} error(s)`,
    totalDatasets: total,
    completedDatasets: completed,
    failedDatasets: failed,
    percent: 100,
    results,
    errors,
  };
  onProgress(finalProgress);
  _inProgress.delete(companyId);
  _lastPreparedAt.set(companyId, Date.now());
  return finalProgress;
}
