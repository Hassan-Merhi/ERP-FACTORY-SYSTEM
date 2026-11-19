// Extracted from ./offlinePrep.ts to keep that module under the source-size cap.
import { asRecord, isRecord, toPositiveInteger } from "@shared/typeGuards";
import { type CachedEntity } from "./db";
import { extractArray, type PrepPack } from "./offlinePrepBuildPacksHelpers";
export {
  _inProgress,
  _lastPreparedAt,
  type DatasetSpec,
  type PrepPack,
  type DatasetResult,
  type PrepProgress,
  type CachedItem,
} from "./offlinePrepBuildPacksHelpers";

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The identifier to cache an item under.
 *
 * Ids arrive as either a number or a string depending on the endpoint. Anything
 * else means the payload did not carry a usable id, so the caller's fallback is
 * used instead of silently caching under "undefined".
 */
function entityId(value: unknown, fallback: string | number): string | number {
  return typeof value === "string" || typeof value === "number" ? value : fallback;
}

/**
 * Map a payload's items to cache entities keyed by each item's own id.
 *
 * An item that carries no usable id has no stable cache key. Writing all such
 * items under one substitute key would have each overwrite the last, so they
 * are skipped instead.
 */
function entitiesById(data: unknown, companyId: number, prefix = ""): CachedEntity[] {
  return extractArray(data).flatMap((item) => {
    const id = entityId(item.id, "");
    return id === "" ? [] : [toEntity(prefix ? `${prefix}${id}` : id, companyId, item)];
  });
}

function toEntity(id: string | number, companyId: number, data: unknown): CachedEntity {
  return {
    id,
    companyId,
    data: JSON.stringify(data),
    updatedAt: Date.now(),
    fetchedAt: Date.now(),
  };
}

// ─── Data Packs ───────────────────────────────────────────────────────────────

export function buildPacks(): PrepPack[] {
  return [
    {
      id: "shared",
      label: "Shared (user & settings)",
      datasets: [
        {
          id: "user",
          label: "Current user",
          endpoint: "/api/auth/me",
          tableKey: "users",
          extractItems: (data, cid) => [toEntity(entityId(asRecord(data)?.id, "me"), cid, data)],
        },
        {
          id: "companies",
          label: "Companies",
          endpoint: "/api/user/companies",
          tableKey: "companies",
          extractItems: (data, _cid) =>
            extractArray(data).flatMap((c) => {
              // Companies are cached under their own id, so a payload without a
              // numeric id has nowhere to go and is dropped rather than cached
              // under a company scope that does not exist.
              const companyId = toPositiveInteger(c.id);
              return companyId === undefined ? [] : [toEntity(companyId, companyId, c)];
            }),
        },
        {
          id: "companySettings",
          label: "Company settings",
          endpoint: "/api/company-settings",
          tableKey: "companySettings",
          extractItems: (data, cid) => [toEntity(cid, cid, data)],
        },
        {
          id: "permissions",
          label: "Page permissions",
          endpoint: "/api/my-erp-pages",
          tableKey: "permissions",
          extractItems: (data, cid) => [toEntity(cid, cid, data)],
        },
        {
          id: "exchangeRates",
          label: "Exchange rates",
          endpoint: "/api/exchange-rates",
          tableKey: null,
          extractItems: (data, cid) =>
            // Exchange-rate rows without an id still belong in the cache: the
            // page reads them as a list rather than by key.
            extractArray(data).map((r) => toEntity(`er_${entityId(r.id, Math.random())}`, cid, r)),
        },
      ],
    },
    {
      id: "erp",
      label: "ERP (accounts, suppliers, stock)",
      datasets: [
        {
          id: "locations",
          label: "Locations",
          endpoint: "/api/locations",
          tableKey: "locations",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "ledgerAccounts",
          label: "Ledger accounts",
          endpoint: "/api/ledger-accounts",
          tableKey: "ledgerAccounts",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "suppliers",
          label: "ERP suppliers",
          endpoint: "/api/suppliers",
          tableKey: "suppliers",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "customers",
          label: "Customers",
          endpoint: "/api/customers",
          tableKey: "customers",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "stockItems",
          label: "Stock items",
          // Use the lightweight endpoint — only id/code/name/uom/barcode/active needed
          // for offline lookups.  The full 649 KB payload is not required here.
          endpoint: "/api/stock-items/light",
          tableKey: "stockItems",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "inventory",
          label: "Inventory levels",
          endpoint: "/api/inventory",
          tableKey: "inventoryByLocation",
          extractItems: (data, cid) =>
            // Backend returns paginated { data, ... } — handle both flat-array
            // and paginated-object formats for forward/backward compatibility.
            (Array.isArray(data) ? data.filter(isRecord) : extractArray(asRecord(data)?.data ?? [])).map((i) =>
              toEntity(
                `${entityId(i.stockItemId ?? i.stock_item_id, "")}_${entityId(i.locationId ?? i.location_id, "")}`,
                cid,
                i
              )
            ),
        },
      ],
    },
    {
      id: "pos",
      label: "POS (drafts & bale products)",
      datasets: [
        {
          id: "posDrafts",
          label: "POS drafts",
          endpoint: "/api/pos/drafts",
          tableKey: null,
          extractItems: (data, cid) => entitiesById(data, cid, "pos_draft_"),
        },
        {
          id: "baleProducts",
          label: "Bale products (ERP)",
          endpoint: "/api/bale-products",
          tableKey: null,
          extractItems: (data, cid) => entitiesById(data, cid, "bp_"),
        },
        {
          id: "employees",
          label: "Employees",
          endpoint: "/api/employees",
          tableKey: "employees",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
      ],
    },
    {
      id: "factory",
      label: "Factory (containers, stock, bales)",
      datasets: [
        {
          id: "factorySuppliers",
          label: "Factory suppliers",
          endpoint: "/api/factory/suppliers",
          tableKey: "factorySuppliers",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "factoryCategories",
          label: "Factory categories",
          endpoint: "/api/factory/categories",
          tableKey: "factoryCategories",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "factoryBaleProducts",
          label: "Factory bale products",
          endpoint: "/api/factory/bale-products",
          tableKey: "factoryBaleProducts",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "factoryContainers",
          label: "Containers",
          endpoint: "/api/factory/containers",
          tableKey: "factoryContainers",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "factoryRawStock",
          label: "Raw stock entries",
          endpoint: "/api/factory/raw-stock",
          tableKey: "factoryRawStock",
          extractItems: (data, cid) => entitiesById(data, cid),
        },
        {
          id: "factorySuppliersWithBalances",
          label: "Supplier balances",
          endpoint: "/api/factory/suppliers/with-balances",
          tableKey: null,
          extractItems: (data, cid) => entitiesById(data, cid, "fsb_"),
        },
        {
          id: "factoryDaybook",
          label: "Factory daybook",
          endpoint: "/api/factory/daybook",
          tableKey: null,
          extractItems: (data, cid) => extractArray(data).map((e) => toEntity(entityId(e.id, Math.random()), cid, e)),
        },
        {
          id: "factoryFxRates",
          label: "FX rates",
          endpoint: "/api/factory/fx-rates",
          tableKey: null,
          extractItems: (data, cid) => extractArray(data).map((r) => toEntity(entityId(r.id, Math.random()), cid, r)),
        },
      ],
    },
  ];
}

// ─── Service Worker Check ─────────────────────────────────────────────────────

export async function ensureServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) {
    await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    // Give SW time to install
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ─── Main Preparation Function ────────────────────────────────────────────────

// ─── Per-company single-flight guard ─────────────────────────────────────────
// Prevents a second runOfflinePrep from starting while one is already in
// progress for the same company.  Also tracks the last completed timestamp
// per company so callers can decide whether a fresh run is needed.
