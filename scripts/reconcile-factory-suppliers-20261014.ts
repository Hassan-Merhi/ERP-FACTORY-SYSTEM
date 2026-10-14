/**
 * Company 12 legacy supplier journal reconciliation (14 October 2026).
 *
 * 39 goods candidates: 38 goods journals + one separately accounted opening
 * balance (BANIN / opening container 66). 48 NASRA commission journals.
 *
 * This runner is explicitly opt-in. It neither modifies container costing nor
 * deletes/rewrites posted vouchers or supplier openings. Each financial posting
 * uses the canonical, balanced, idempotent factory engine and its source identity.
 *
 * Dry-run: npx tsx scripts/reconcile-factory-suppliers-20261014.ts
 * Apply:   npx tsx scripts/reconcile-factory-suppliers-20261014.ts --apply
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../server/db";
import { MoneyDecimal, toMoney } from "../server/lib/money";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { systemAccountIdsTx } from "../server/services/accounting/perpetualInventory/linkedJournal";
import { syncContainerCommissionJournalTx } from "../server/services/factory/containerCommissionJournal";
import { postFactoryVoucherTx } from "../server/services/factory/factoryVoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const GOODS_IDS = new Set([23,66,77,83,87,88,89,90,91,92,93,102,103,111,112,113,114,115,116,120,122,123,125,132,134,138,139,145,146,147,148,149,150,151,152,168,176,209,210]);
const COMMISSION_IDS = new Set([46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,67,68,69,70,72,74,75,76,87,88,89,90,91,92,136,137,140,141,142,143,146,147,148,149,150,151,162,163]);
const OPENING_CONTAINER_ID = 66;
const NASRA_ID = 27;

interface ContainerCandidate {
  id: number;
  container_number: string;
  status: string | null;
  supplier_id: number | null;
  commission_supplier_id: number | null;
  total_kg: string;
  rate_per_kg: string;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  commission_amount: string | null;
  commission_currency_code: string | null;
  arrival_date: string | null;
  created_on: string;
}

function goodsAmount(row: ContainerCandidate) {
  return toMoney(row.total_kg).times(toMoney(row.rate_per_kg));
}

async function snapshot(): Promise<ContainerCandidate[]> {
  const result = await db.execute<ContainerCandidate & Record<string, unknown>>(sql`
    SELECT id, container_number, status, supplier_id, commission_supplier_id,
           total_kg::text AS total_kg, rate_per_kg::text AS rate_per_kg,
           currency_code, fx_rate_to_usd::text AS fx_rate_to_usd, fx_rate_confirmed,
           commission_amount::text AS commission_amount, commission_currency_code,
           arrival_date, created_at::date::text AS created_on
      FROM factory_containers
     WHERE company_id = ${COMPANY} AND deleted_at IS NULL
       AND id IN (${sql.join([...new Set([...GOODS_IDS, ...COMMISSION_IDS])].map((id) => sql`${id}`), sql`, `)})
     ORDER BY id
  `);
  return result.rows as ContainerCandidate[];
}

async function liveVoucher(tx: DbTransaction, prefix: string): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT id FROM vouchers
     WHERE company_id = ${COMPANY} AND deleted_at IS NULL AND optional = false
       AND (voucher_number = ${prefix} OR voucher_number LIKE ${`${prefix}-%`})
     ORDER BY id LIMIT 1
  `);
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

async function beforeAndAfterSupplier(tx: DbTransaction, supplierId: number) {
  const balance = await getPartyBalance(tx, {
    companyId: COMPANY,
    kind: "factorySupplier",
    id: supplierId,
    memo: true,
  });
  if (!balance) throw new Error(`Missing factory supplier ${supplierId}`);
  return toMoney(balance.closing).plus(toMoney(balance.memoTotal));
}

function ensureUnchanged(initial: ContainerCandidate, latest: ContainerCandidate) {
  for (const key of ["container_number", "status", "supplier_id", "commission_supplier_id",
    "total_kg", "rate_per_kg", "currency_code", "fx_rate_to_usd", "fx_rate_confirmed",
    "commission_amount", "commission_currency_code", "arrival_date"] as const) {
    if (String(initial[key] ?? "") !== String(latest[key] ?? "")) {
      throw new Error(`Container ${latest.id} changed since the historical posting audit (${key}); stop`);
    }
  }
}

async function lockedContainer(tx: DbTransaction, initial: ContainerCandidate): Promise<ContainerCandidate> {
  const result = await tx.execute<ContainerCandidate & Record<string, unknown>>(sql`
    SELECT id, container_number, status, supplier_id, commission_supplier_id,
           total_kg::text AS total_kg, rate_per_kg::text AS rate_per_kg,
           currency_code, fx_rate_to_usd::text AS fx_rate_to_usd, fx_rate_confirmed,
           commission_amount::text AS commission_amount, commission_currency_code,
           arrival_date, created_at::date::text AS created_on
      FROM factory_containers
     WHERE company_id = ${COMPANY} AND id = ${initial.id} AND deleted_at IS NULL
     FOR UPDATE
  `);
  const latest = result.rows[0];
  if (!latest) throw new Error(`Missing or deleted container ${initial.id}`);
  ensureUnchanged(initial, latest);
  return latest;
}

async function verifyOpeningBalance(): Promise<void> {
  const result = await db.execute(sql`
    SELECT fc.status, fc.supplier_id, fc.total_kg, fc.rate_per_kg,
           fc.currency_code, fs.opening_balance
      FROM factory_containers fc
      JOIN factory_suppliers fs ON fs.id = fc.supplier_id AND fs.company_id = fc.company_id
     WHERE fc.company_id = ${COMPANY} AND fc.id = ${OPENING_CONTAINER_ID}
       AND fc.deleted_at IS NULL
  `);
  const row = result.rows[0];
  if (!row || row.status !== "OPENING_BALANCE" || Number(row.supplier_id) !== 34 ||
      String(row.currency_code ?? "USD").toUpperCase() !== "USD" ||
      !toMoney(row.total_kg as string).times(toMoney(row.rate_per_kg as string)).eq("460") ||
      !toMoney(row.opening_balance as string).eq("-460")) {
    throw new Error("BANIN opening-balance evidence changed: do not post or hide container #66");
  }
}

async function run(apply: boolean): Promise<void> {
  const rows = await snapshot();
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  if ([...GOODS_IDS, ...COMMISSION_IDS].some((id) => !byId.has(id))) {
    throw new Error("An audited container is missing: stop and re-audit");
  }
  await verifyOpeningBalance();

  const importIds = [...GOODS_IDS].filter((id) => id !== OPENING_CONTAINER_ID);
  const native = new Map<string, ReturnType<typeof toMoney>>();
  for (const id of importIds) {
    const row = byId.get(id)!;
    if (!row.supplier_id || !goodsAmount(row).greaterThan(0)) throw new Error(`Invalid goods #${id}`);
    const currency = String(row.currency_code ?? "USD").toUpperCase();
    if (currency !== "USD" && (row.fx_rate_confirmed !== true || !toMoney(row.fx_rate_to_usd).greaterThan(0))) {
      throw new Error(`Unconfirmed FX on goods #${id}`);
    }
    native.set(currency, (native.get(currency) ?? new MoneyDecimal(0)).plus(goodsAmount(row)));
  }
  for (const id of COMMISSION_IDS) {
    const row = byId.get(id)!;
    if (row.commission_supplier_id !== NASRA_ID || !toMoney(row.commission_amount).greaterThan(0) ||
        String(row.commission_currency_code ?? row.currency_code ?? "USD").toUpperCase() !== "USD") {
      throw new Error(`NASRA commission changed on container #${id}`);
    }
  }

  const expectedCommission = [...COMMISSION_IDS].reduce(
    (total, id) => total.plus(toMoney(byId.get(id)!.commission_amount)),
    new MoneyDecimal(0)
  );
  if (!expectedCommission.eq("32500")) throw new Error("NASRA commission preflight differs from $32,500");
  console.log(`[SupplierRepair] ${apply ? "APPLY" : "DRY RUN"}: 38 goods, 48 NASRA commissions, 1 BANIN opening liability already held.`);
  for (const [currency, amount] of native) console.log(`[SupplierRepair] Goods ${currency}: ${amount.toFixed(2)}`);
  console.log(`[SupplierRepair] NASRA commission USD: ${expectedCommission.toFixed(2)}`);
  if (!apply) return;

  let postedGoods = 0;
  let postedCommissions = 0;
  for (const id of importIds.sort((a, b) => a - b)) {
    const initial = byId.get(id)!;
    await db.transaction(async (tx) => {
      const row = await lockedContainer(tx, initial);
      if (await liveVoucher(tx, `FACTORY-IMPORT-${id}`)) {
        console.log(`[SupplierRepair] Goods #${id} already journaled; skipped`);
        return;
      }
      const before = await beforeAndAfterSupplier(tx, Number(row.supplier_id));
      const account = (await systemAccountIdsTx(tx, COMPANY, ["FACTORY_IMPORT_COST"])).get("FACTORY_IMPORT_COST");
      if (!account) throw new Error("Missing company-specific Factory Import Cost ledger account");
      const amount = goodsAmount(row);
      const currency = String(row.currency_code ?? "USD").toUpperCase();
      const rate = currency === "USD" ? "1" : String(row.fx_rate_to_usd);
      const voucher = await postFactoryVoucherTx(tx, {
        companyId: COMPANY,
        voucherNumber: (generation) => `FACTORY-IMPORT-${id}-${generation}`,
        voucherDate: row.arrival_date || row.created_on,
        description: `Goods import - container ${row.container_number} (historical supplier reconciliation)`,
        currency,
        fxRateToUsd: rate,
        source: { sourceType: "factory-container-import", sourceId: id, phase: "goods" },
        lines: [
          { ledgerAccountId: account, debit: amount, narration: `Goods import cost - container ${row.container_number}` },
          { factorySupplierId: Number(row.supplier_id), credit: amount,
            narration: `Goods payable to supplier - container ${row.container_number}` },
        ],
      });
      if (!voucher.voucher.id) throw new Error(`Goods #${id} did not post`);
      const after = await beforeAndAfterSupplier(tx, Number(row.supplier_id));
      if (after.minus(before).abs().greaterThan("0.01")) {
        throw new Error(`Supplier #${row.supplier_id} balance drift after goods #${id}: ${before.toFixed(2)} => ${after.toFixed(2)}`);
      }
      postedGoods += 1;
      console.log(`[SupplierRepair] Goods #${id} => voucher ${voucher.voucher.id}; supplier combined balance unchanged`);
    });
  }

  for (const id of [...COMMISSION_IDS].sort((a, b) => a - b)) {
    const initial = byId.get(id)!;
    await db.transaction(async (tx) => {
      await lockedContainer(tx, initial);
      if (await liveVoucher(tx, `FACTORY-COMM-${id}`)) {
        console.log(`[SupplierRepair] Commission #${id} already journaled; skipped`);
        return;
      }
      const before = await beforeAndAfterSupplier(tx, NASRA_ID);
      const result = await syncContainerCommissionJournalTx(tx, COMPANY, id);
      if (!result.voucherId) throw new Error(`Commission #${id} failed to post: ${result.skipped}`);
      const after = await beforeAndAfterSupplier(tx, NASRA_ID);
      if (after.minus(before).abs().greaterThan("0.01")) {
        throw new Error(`NASRA balance drift after commission #${id}: ${before.toFixed(2)} => ${after.toFixed(2)}`);
      }
      postedCommissions += 1;
      console.log(`[SupplierRepair] Commission #${id} => voucher ${result.voucherId}; NASRA combined balance unchanged`);
    });
  }

  const missingGoods = [];
  for (const id of importIds) {
    const result = await db.execute(sql`SELECT 1 FROM vouchers WHERE company_id = ${COMPANY}
      AND deleted_at IS NULL AND optional = false AND voucher_number LIKE ${`FACTORY-IMPORT-${id}-%`} LIMIT 1`);
    if (!result.rows.length) missingGoods.push(id);
  }
  const missingComm = [];
  for (const id of COMMISSION_IDS) {
    const result = await db.execute(sql`SELECT 1 FROM vouchers WHERE company_id = ${COMPANY}
      AND deleted_at IS NULL AND optional = false
      AND (voucher_number = ${`FACTORY-COMM-${id}`} OR voucher_number LIKE ${`FACTORY-COMM-${id}-%`}) LIMIT 1`);
    if (!result.rows.length) missingComm.push(id);
  }
  if (missingGoods.length || missingComm.length) {
    throw new Error(`Supplier reconciliation incomplete: goods=${missingGoods.join(",")}, commissions=${missingComm.join(",")}`);
  }
  console.log(`[SupplierRepair] DONE: posted goods=${postedGoods}, commissions=${postedCommissions}, BANIN #66 covered by opening; 87/87 reconciled.`);
}

export function reconcileFactorySuppliers20261014(apply: boolean): Promise<void> {
  return runWithDatabaseScopeRuntimeContext(
    createTenantDatabaseScope(COMPANY), () => run(apply)
  );
}

if (process.argv[1]?.includes("reconcile-factory-suppliers-20261014")) {
  void reconcileFactorySuppliers20261014(process.argv.includes("--apply"))
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
