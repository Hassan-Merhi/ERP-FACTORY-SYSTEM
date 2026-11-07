#!/usr/bin/env node
/**
 * Staging drill reconciliation for the offline plan batches (2026-11-06).
 *
 * Read-only. Compares the staging factory server's database with the staging
 * cloud's after a drill's handover and reports:
 *
 *   failures     every LAN offline record has exactly one cloud outcome; items
 *                created offline are mapped once to a live cloud item with the
 *                same code; applied deletes are deleted in the cloud; no voucher
 *                number appears twice; files whose records all applied match
 *                (name, folder, size, SHA-256);
 *   differences  stock on hand (batches 2 and 3) and ledger balances (batch 4)
 *                that differ between the two sides. Each must be explained by a
 *                change planted in the cloud during the drill, or by a record
 *                that was rejected; the drill record lists the explanation.
 *
 * Usage (on a machine that reaches both staging databases):
 *
 *   DRILL_LAN_DATABASE_URL=postgres://...   # staging factory server
 *   DRILL_CLOUD_DATABASE_URL=postgres://... # staging cloud
 *   node scripts/edge/drill-reconcile.mjs --batch 2 --company 7 --site <uuid> [--json]
 *
 * Exit codes: 0 all clear, 1 failures, 2 only differences to explain,
 * 64 bad arguments or configuration.
 *
 * Never point it at production: it refuses a URL that does not contain
 * "staging" or "drill" unless DRILL_RECONCILE_ALLOW_ANY_URL=1 is set for a
 * disposable test database.
 */
import pg from "pg";

export const DRILL_BATCHES = Object.freeze([2, 3, 4]);
const LAN_ITEM_ID_BASE = 1_000_000_000;
const QUANTITY_TOLERANCE = 0.0005;
const AMOUNT_TOLERANCE = 0.005;

/** LAN outbox table per Phase 9 stream (same as scripts/edge/relay-event-outbox.mjs). */
export const STREAM_OUTBOXES = Object.freeze({
  pressing: { table: "factory_edge_pressing_outbox", localRef: "local_confirmation_id" },
  stock: { table: "factory_edge_stock_outbox", localRef: "local_movement_id" },
  pos: { table: "factory_edge_pos_outbox", localRef: "local_voucher_id" },
  receiving: { table: "factory_edge_receiving_outbox", localRef: "local_offload_id" },
  attachments: { table: "factory_edge_attachment_outbox", localRef: "local_file_id" },
  payments: { table: "factory_edge_payment_outbox", localRef: "local_voucher_id" },
});

export class DrillUsageError extends Error {}

export function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--batch" || arg === "--company" || arg === "--site") {
      const value = argv[i + 1];
      if (value === undefined) throw new DrillUsageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else throw new DrillUsageError(`unknown argument ${arg}`);
  }
  const batch = Number(options.batch);
  if (!DRILL_BATCHES.includes(batch)) throw new DrillUsageError("--batch must be 2, 3 or 4");
  const companyId = Number(options.company);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new DrillUsageError("--company must be a company id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.site ?? "")) {
    throw new DrillUsageError("--site must be the factory site UUID (FACTORY_EDGE_SITE_ID)");
  }
  return { batch, companyId, siteId: options.site.toLowerCase(), json: options.json };
}

export function assertStagingUrl(name, url, env = process.env) {
  if (!url) throw new DrillUsageError(`${name} is not set`);
  if (env.DRILL_RECONCILE_ALLOW_ANY_URL === "1") return;
  if (!/staging|drill/i.test(url)) {
    throw new DrillUsageError(`${name} does not look like a staging database (expected "staging" or "drill" in it)`);
  }
}

// ---- pure comparisons (exported for tests) ---------------------------------

/** Every LAN record needs exactly one cloud outcome for the same operation. */
export function compareEvents(lanRecords, cloudEvents) {
  const failures = [];
  const outcomes = {};
  const cloudByOperation = new Map();
  for (const event of cloudEvents) {
    const key = `${event.stream}:${event.operation_id}`;
    cloudByOperation.set(key, [...(cloudByOperation.get(key) ?? []), event]);
  }
  for (const record of lanRecords) {
    const matches = cloudByOperation.get(`${record.stream}:${record.operation_id}`) ?? [];
    if (matches.length !== 1) {
      failures.push({
        check: "event-outcome",
        stream: record.stream,
        sequence: String(record.sequence),
        kind: record.operation_kind,
        detail: matches.length === 0 ? "no cloud outcome" : `${matches.length} cloud outcomes`,
      });
      continue;
    }
    const outcome = matches[0].outcome;
    outcomes[record.stream] ??= {};
    outcomes[record.stream][outcome] = (outcomes[record.stream][outcome] ?? 0) + 1;
  }
  return { failures, outcomes };
}

/** Items created offline: one map row to a live cloud item with the typed code. */
export function compareItemCreates(createEvents, mapRows, cloudItems) {
  const failures = [];
  const mapByLan = new Map(mapRows.map((row) => [Number(row.lan_item_id), Number(row.cloud_item_id)]));
  const itemsById = new Map(cloudItems.map((item) => [Number(item.id), item]));
  for (const event of createEvents) {
    if (event.outcome === "rejected-conflict") continue;
    const lanId = Number(event.local_ref);
    const cloudId = mapByLan.get(lanId);
    if (cloudId === undefined || cloudId !== Number(event.cloud_ref)) {
      failures.push({ check: "item-map", lanItemId: lanId, detail: "missing or different map row" });
      continue;
    }
    const item = itemsById.get(cloudId);
    if (!item) failures.push({ check: "item-map", lanItemId: lanId, cloudItemId: cloudId, detail: "cloud item missing" });
    else if (event.code && item.code !== event.code) {
      failures.push({ check: "item-map", lanItemId: lanId, cloudItemId: cloudId, detail: `code ${item.code} ≠ ${event.code}` });
    }
  }
  return failures;
}

export function compareItemDeletes(deleteEvents, cloudItems) {
  const itemsById = new Map(cloudItems.map((item) => [Number(item.id), item]));
  return deleteEvents
    .filter((event) => event.outcome !== "rejected-conflict")
    .filter((event) => {
      const item = itemsById.get(Number(event.cloud_ref));
      return !item || item.deleted_at === null;
    })
    .map((event) => ({ check: "item-delete", cloudItemId: Number(event.cloud_ref), detail: "not deleted in the cloud" }));
}

/** Stock on hand per (location, item); LAN-created items are translated through the map. */
export function compareInventory(lanRows, cloudRows, mapRows) {
  const mapByLan = new Map(mapRows.map((row) => [Number(row.lan_item_id), Number(row.cloud_item_id)]));
  const key = (locationId, itemId) => `${locationId}:${itemId}`;
  const lan = new Map();
  const unmapped = [];
  for (const row of lanRows) {
    let itemId = Number(row.stock_item_id);
    if (itemId >= LAN_ITEM_ID_BASE) {
      const mapped = mapByLan.get(itemId);
      if (mapped === undefined) {
        if (Math.abs(Number(row.quantity)) > QUANTITY_TOLERANCE) {
          unmapped.push({ check: "stock", locationId: Number(row.location_id), lanItemId: itemId, lan: Number(row.quantity), detail: "item created offline has no cloud item (create rejected?)" });
        }
        continue;
      }
      itemId = mapped;
    }
    const k = key(Number(row.location_id), itemId);
    lan.set(k, (lan.get(k) ?? 0) + Number(row.quantity));
  }
  const cloud = new Map(cloudRows.map((row) => [key(Number(row.location_id), Number(row.stock_item_id)), Number(row.quantity)]));
  const differences = [...unmapped];
  for (const k of new Set([...lan.keys(), ...cloud.keys()])) {
    const a = lan.get(k) ?? 0;
    const b = cloud.get(k) ?? 0;
    if (Math.abs(a - b) > QUANTITY_TOLERANCE) {
      const [locationId, stockItemId] = k.split(":").map(Number);
      differences.push({ check: "stock", locationId, stockItemId, lan: a, cloud: b });
    }
  }
  return differences.sort((x, y) => (x.locationId - y.locationId) || ((x.stockItemId ?? 0) - (y.stockItemId ?? 0)));
}

export function compareBalances(lanRows, cloudRows) {
  const lan = new Map(lanRows.map((row) => [Number(row.ledger_account_id), Number(row.balance)]));
  const cloud = new Map(cloudRows.map((row) => [Number(row.ledger_account_id), Number(row.balance)]));
  const differences = [];
  for (const id of new Set([...lan.keys(), ...cloud.keys()])) {
    const a = lan.get(id) ?? 0;
    const b = cloud.get(id) ?? 0;
    if (Math.abs(a - b) > AMOUNT_TOLERANCE) differences.push({ check: "ledger", ledgerAccountId: id, lan: a, cloud: b });
  }
  return differences.sort((x, y) => x.ledgerAccountId - y.ledgerAccountId);
}

/** A file is compared when every record about it applied; otherwise a mismatch is a difference to explain. */
export function compareFiles(attachmentEvents, lanFiles, cloudFiles) {
  const failures = [];
  const differences = [];
  const pairs = new Map();
  for (const event of attachmentEvents) {
    const k = `${event.local_ref}:${event.cloud_ref ?? ""}`;
    const pair = pairs.get(k) ?? { localRef: Number(event.local_ref), cloudRef: event.cloud_ref === null ? null : Number(event.cloud_ref), rejected: false };
    if (event.outcome === "rejected-conflict") pair.rejected = true;
    pairs.set(k, pair);
  }
  const lanById = new Map(lanFiles.map((file) => [Number(file.id), file]));
  const cloudById = new Map(cloudFiles.map((file) => [Number(file.id), file]));
  for (const pair of pairs.values()) {
    if (pair.cloudRef === null) continue;
    const a = lanById.get(pair.localRef);
    const b = cloudById.get(pair.cloudRef);
    const fields = ["display_name", "folder_id", "file_size", "sha256"];
    const changed = !a || !b ? ["missing"] : fields.filter((field) => String(a[field] ?? "") !== String(b[field] ?? ""));
    if (changed.length === 0) continue;
    const entry = { check: "file", lanFileId: pair.localRef, cloudFileId: pair.cloudRef, detail: changed.join(", ") };
    (pair.rejected ? differences : failures).push(entry);
  }
  return { failures, differences };
}

export function duplicateVoucherNumbers(rows) {
  return rows.map((row) => ({ check: "voucher-number", voucherNumber: row.voucher_number, detail: `${row.count} live vouchers` }));
}

// ---- database reads ---------------------------------------------------------

async function tableExists(client, table) {
  const found = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
  return found.rows[0].present === true;
}

async function lanRecords(lan, siteId, companyId) {
  const rows = [];
  for (const [stream, source] of Object.entries(STREAM_OUTBOXES)) {
    if (!(await tableExists(lan, source.table))) continue;
    const found = await lan.query(
      `SELECT sequence, operation_id::text AS operation_id, operation_kind
         FROM ${source.table} WHERE site_id = $1::uuid AND company_id = $2 ORDER BY sequence`,
      [siteId, companyId]
    );
    rows.push(...found.rows.map((row) => ({ ...row, stream })));
  }
  return rows;
}

async function cloudEvents(cloud, siteId, companyId) {
  const found = await cloud.query(
    `SELECT stream, sequence, operation_id::text AS operation_id, operation_kind, local_ref, cloud_ref, outcome
       FROM factory_edge_applied_events WHERE site_id = $1::uuid AND company_id = $2`,
    [siteId, companyId]
  );
  return found.rows;
}

async function inventoryRows(client, companyId) {
  const found = await client.query(
    "SELECT location_id, stock_item_id, quantity FROM inventory WHERE company_id = $1",
    [companyId]
  );
  return found.rows;
}

async function stockItemMap(cloud, siteId) {
  if (!(await tableExists(cloud, "factory_edge_stock_item_map"))) return [];
  const found = await cloud.query(
    "SELECT lan_item_id, cloud_item_id FROM factory_edge_stock_item_map WHERE site_id = $1::uuid",
    [siteId]
  );
  return found.rows;
}

async function cloudItems(cloud, companyId, ids) {
  if (ids.length === 0) return [];
  const found = await cloud.query(
    "SELECT id, code, deleted_at FROM stock_items WHERE company_id = $1 AND id = ANY($2::int[])",
    [companyId, ids]
  );
  return found.rows;
}

async function createCodes(lan, siteId, companyId) {
  if (!(await tableExists(lan, "factory_edge_stock_outbox"))) return new Map();
  const found = await lan.query(
    `SELECT operation_id::text AS operation_id, payload->'item'->>'code' AS code
       FROM factory_edge_stock_outbox
      WHERE site_id = $1::uuid AND company_id = $2 AND operation_kind = 'stock.item-create.v1'`,
    [siteId, companyId]
  );
  return new Map(found.rows.map((row) => [row.operation_id, row.code]));
}

async function ledgerBalances(client, companyId) {
  const found = await client.query(
    `SELECT ve.ledger_account_id, SUM(COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0))::text AS balance
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id AND v.company_id = ve.company_id
      WHERE ve.company_id = $1 AND v.deleted_at IS NULL AND ve.ledger_account_id IS NOT NULL
      GROUP BY ve.ledger_account_id`,
    [companyId]
  );
  return found.rows;
}

async function duplicateVouchers(cloud, companyId) {
  const found = await cloud.query(
    `SELECT voucher_number, count(*)::int AS count FROM vouchers
      WHERE company_id = $1 AND deleted_at IS NULL AND voucher_number IS NOT NULL
      GROUP BY voucher_number HAVING count(*) > 1 ORDER BY voucher_number`,
    [companyId]
  );
  return found.rows;
}

async function fileRows(client, companyId, ids) {
  if (ids.length === 0) return [];
  const found = await client.query(
    `SELECT id, display_name, folder_id, file_size,
            encode(sha256(convert_to(COALESCE(file_data, ''), 'UTF8')), 'hex') AS sha256
       FROM stored_files WHERE company_id = $1 AND id = ANY($2::int[])`,
    [companyId, ids]
  );
  return found.rows;
}

// ---- the run ----------------------------------------------------------------

export async function runDrillReconciliation({ lan, cloud, batch, companyId, siteId }) {
  const failures = [];
  const differences = [];

  const records = await lanRecords(lan, siteId, companyId);
  const events = await cloudEvents(cloud, siteId, companyId);
  const eventCheck = compareEvents(records, events);
  failures.push(...eventCheck.failures);

  if (batch === 2 || batch === 3) {
    const map = await stockItemMap(cloud, siteId);
    if (batch === 2) {
      const codes = await createCodes(lan, siteId, companyId);
      const creates = events
        .filter((event) => event.stream === "stock" && event.operation_kind === "stock.item-create.v1")
        .map((event) => ({ ...event, code: codes.get(event.operation_id) ?? null }));
      const deletes = events.filter((event) => event.stream === "stock" && event.operation_kind === "stock.item-delete.v1");
      const ids = [...new Set([...creates, ...deletes].map((event) => Number(event.cloud_ref)).filter((id) => id > 0))];
      const items = await cloudItems(cloud, companyId, ids);
      failures.push(...compareItemCreates(creates, map, items), ...compareItemDeletes(deletes, items));
    }
    differences.push(...compareInventory(await inventoryRows(lan, companyId), await inventoryRows(cloud, companyId), map));
  }

  if (batch === 3 || batch === 4) failures.push(...duplicateVoucherNumbers(await duplicateVouchers(cloud, companyId)));

  if (batch === 4) {
    differences.push(...compareBalances(await ledgerBalances(lan, companyId), await ledgerBalances(cloud, companyId)));
    const attachmentEvents = events.filter((event) => event.stream === "attachments");
    const lanIds = [...new Set(attachmentEvents.map((event) => Number(event.local_ref)))];
    const cloudIds = [...new Set(attachmentEvents.map((event) => Number(event.cloud_ref)).filter((id) => id > 0))];
    const fileCheck = compareFiles(attachmentEvents, await fileRows(lan, companyId, lanIds), await fileRows(cloud, companyId, cloudIds));
    failures.push(...fileCheck.failures);
    differences.push(...fileCheck.differences);
  }

  return {
    batch,
    companyId,
    siteId,
    lanRecords: records.length,
    outcomes: eventCheck.outcomes,
    failures,
    differences,
    status: failures.length > 0 ? "failed" : differences.length > 0 ? "differences-to-explain" : "clear",
  };
}

export function exitCodeFor(report) {
  if (report.failures.length > 0) return 1;
  if (report.differences.length > 0) return 2;
  return 0;
}

function printReport(report) {
  console.log(`Batch ${report.batch} drill reconciliation — company ${report.companyId}, site ${report.siteId}`);
  console.log(`LAN offline records: ${report.lanRecords}`);
  for (const [stream, counts] of Object.entries(report.outcomes)) {
    console.log(`  ${stream}: ${Object.entries(counts).map(([outcome, n]) => `${n} ${outcome}`).join(", ")}`);
  }
  console.log(`Failures: ${report.failures.length}`);
  for (const failure of report.failures) console.log(`  FAIL ${JSON.stringify(failure)}`);
  console.log(`Differences to explain: ${report.differences.length}`);
  for (const difference of report.differences) console.log(`  DIFF ${JSON.stringify(difference)}`);
  console.log(`Result: ${report.status}`);
}

async function readOnlyClient(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  return client;
}

async function main(argv) {
  const options = parseArgs(argv);
  const lanUrl = process.env.DRILL_LAN_DATABASE_URL;
  const cloudUrl = process.env.DRILL_CLOUD_DATABASE_URL;
  assertStagingUrl("DRILL_LAN_DATABASE_URL", lanUrl);
  assertStagingUrl("DRILL_CLOUD_DATABASE_URL", cloudUrl);
  const lan = await readOnlyClient(lanUrl);
  const cloud = await readOnlyClient(cloudUrl);
  try {
    const report = await runDrillReconciliation({ lan, cloud, ...options });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return exitCodeFor(report);
  } finally {
    await lan.query("ROLLBACK").catch(() => undefined);
    await cloud.query("ROLLBACK").catch(() => undefined);
    await lan.end();
    await cloud.end();
  }
}

if (process.argv[1] && /drill-reconcile\.mjs$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof DrillUsageError ? `drill-reconcile: ${error.message}` : error);
      process.exit(error instanceof DrillUsageError ? 64 : 1);
    });
}
