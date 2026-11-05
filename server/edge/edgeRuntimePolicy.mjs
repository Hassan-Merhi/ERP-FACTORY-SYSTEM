/** Factory LAN edge: explicit opt-in, never inferred from network reachability. */
const SAFE_EDGE_HOSTS = new Set(["postgres", "db", "localhost", "127.0.0.1", "::1"]);
const PRIMARY_ACK = "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED";
const CLOUD_FENCE_ACK = "CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF";
// Only the reviewed HTTP verb + path pairs escape a read-only LAN fence.
// A future PUT/PATCH/DELETE route must never inherit a POST session exemption.
const SAFE_SESSION_WRITES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/set-company",
  "POST /api/csp-report",
]);

function parseSite(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function parseHostname(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(value) &&
    !value.includes("..")
  );
}

/** Plan batches whose offline routes need an explicit drill approval before the LAN accepts them. */
export const PHASE9_GATED_PLAN_BATCHES = Object.freeze([2, 3, 4]);

function parsePlanBatches(value) {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  const batches = value.split(",").map((part) => part.trim());
  if (batches.some((part) => !/^[1-9]$/.test(part) || !PHASE9_GATED_PLAN_BATCHES.includes(Number(part)))) {
    throw new Error("EDGE_PLAN_BATCHES_INVALID");
  }
  return Object.freeze([...new Set(batches.map(Number))].sort());
}

export function readFactoryEdgeConfiguration(env = process.env) {
  const mode = env.FACTORY_EDGE_MODE || "cloud";
  if (mode !== "cloud" && mode !== "lan") throw new Error("EDGE_MODE_INVALID");
  if (mode === "cloud") {
    if (env.FACTORY_EDGE_WRITE_MODE || env.FACTORY_EDGE_PRIMARY_ACK) {
      throw new Error("EDGE_CLOUD_MISCONFIGURED");
    }
    const cloudWriteMode = env.FACTORY_CLOUD_WRITE_MODE || "primary";
    if (cloudWriteMode !== "primary" && cloudWriteMode !== "fenced") {
      throw new Error("CLOUD_WRITE_MODE_INVALID");
    }
    if (cloudWriteMode === "fenced" && env.FACTORY_CLOUD_FENCE_ACK !== CLOUD_FENCE_ACK) {
      throw new Error("CLOUD_FENCE_NOT_ACKNOWLEDGED");
    }
    if (cloudWriteMode === "primary" && env.FACTORY_CLOUD_FENCE_ACK) {
      throw new Error("CLOUD_FENCE_ACK_WITHOUT_FENCE");
    }
    return Object.freeze({
      mode: "cloud",
      siteId: null,
      hostname: null,
      writeMode: cloudWriteMode === "fenced" ? "fenced" : "cloud",
      primary: false,
    });
  }
  if (env.FACTORY_CLOUD_WRITE_MODE || env.FACTORY_CLOUD_FENCE_ACK) {
    throw new Error("EDGE_CLOUD_FENCE_MISCONFIGURED");
  }

  if (env.NODE_ENV !== "production") throw new Error("EDGE_REQUIRES_PRODUCTION");
  if (!parseSite(env.FACTORY_EDGE_SITE_ID)) throw new Error("EDGE_SITE_ID_INVALID");
  if (!parseHostname(env.FACTORY_EDGE_HOSTNAME)) throw new Error("EDGE_HOSTNAME_INVALID");
  if (env.DATABASE_URL) throw new Error("EDGE_DATABASE_URL_FORBIDDEN");
  if (!SAFE_EDGE_HOSTS.has(env.PGHOST || "")) throw new Error("EDGE_DATABASE_HOST_NOT_LOCAL");
  if (!env.PGUSER || !env.PGPASSWORD || !env.PGDATABASE || !env.PGPORT) {
    throw new Error("EDGE_DATABASE_UNCONFIGURED");
  }
  if (env.PGPASSWORD.length < 32 || /^REPLACE/i.test(env.PGPASSWORD)) {
    throw new Error("EDGE_DATABASE_PASSWORD_WEAK");
  }
  if (env.SESSION_SECRET && /^REPLACE/i.test(env.SESSION_SECRET)) {
    throw new Error("EDGE_SESSION_SECRET_PLACEHOLDER");
  }
  if (env.PGSSLMODE !== "disable") throw new Error("EDGE_DATABASE_MUST_USE_PRIVATE_NETWORK");
  if (env.CSRF_ENFORCE !== "1") throw new Error("EDGE_CSRF_REQUIRED");
  if (env.ENABLE_SCHEDULERS !== "false") throw new Error("EDGE_SCHEDULERS_MUST_BE_DISABLED");
  if (env.RUN_STARTUP_MIGRATIONS !== "true") throw new Error("EDGE_MIGRATIONS_REQUIRED");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 48) throw new Error("EDGE_SESSION_SECRET_WEAK");
  if (env.CAPACITOR_ENABLED === "true") throw new Error("EDGE_CROSS_ORIGIN_SESSIONS_DISABLED");
  const writeMode = env.FACTORY_EDGE_WRITE_MODE || "read-only";
  if (writeMode !== "read-only" && writeMode !== "lan-primary") throw new Error("EDGE_WRITE_MODE_INVALID");
  if (writeMode === "lan-primary" && env.FACTORY_EDGE_PRIMARY_ACK !== PRIMARY_ACK) {
    throw new Error("EDGE_PRIMARY_CUTOVER_NOT_ACKNOWLEDGED");
  }
  if (writeMode !== "lan-primary" && env.FACTORY_EDGE_PRIMARY_ACK) {
    throw new Error("EDGE_UNEXPECTED_PRIMARY_ACK");
  }
  // Phase 7: the operator ACK alone is not sufficient for authority.
  // The DB-installed fence must match an exact positive epoch and a verified
  // encrypted source baseline. An unconfigured/privileged DB role still blocks.
  const writerEpoch = env.FACTORY_EDGE_WRITER_EPOCH || "";
  const baselineSha256 = env.FACTORY_EDGE_BASELINE_SHA256 || "";
  if (writeMode === "lan-primary") {
    if (!/^[1-9][0-9]{0,14}$/.test(writerEpoch) || !Number.isSafeInteger(Number(writerEpoch))) {
      throw new Error("EDGE_PHASE7_WRITER_EPOCH_REQUIRED");
    }
    if (!/^[0-9a-f]{64}$/.test(baselineSha256)) {
      throw new Error("EDGE_PHASE7_BASELINE_DIGEST_REQUIRED");
    }
  } else if (writerEpoch || baselineSha256) {
    throw new Error("EDGE_PHASE7_EPOCH_WITHOUT_PRIMARY");
  }

  // Owner plan rule (2026-11-05): each plan batch's offline routes stay refused
  // on the factory server until its staging drill is run and approved, which
  // the operator records here (for example "2,3").
  const approvedPlanBatches = parsePlanBatches(env.FACTORY_EDGE_APPROVED_PLAN_BATCHES);

  return Object.freeze({
    mode: "lan",
    approvedPlanBatches,
    siteId: env.FACTORY_EDGE_SITE_ID,
    hostname: env.FACTORY_EDGE_HOSTNAME,
    writeMode,
    primary: writeMode === "lan-primary",
    writerEpoch: writeMode === "lan-primary" ? writerEpoch : null,
    baselineSha256: writeMode === "lan-primary" ? baselineSha256 : null,
  });
}

export const PHASE9_PRESSING_CONFIRM_ROUTE = "POST /api/factory/pressing-machines/confirm";
export const PHASE9_STOCK_ADJUST_ROUTE = "POST /api/inventory/quick-adjust";
export const PHASE9_POS_SALE_ROUTE = "POST /api/pos/sales";
export const PHASE9_ATTACHMENT_UPLOAD_ROUTE = "POST /api/files/upload";
export const PHASE9_PAYMENT_RECEIPT_ROUTE = "POST /api/vouchers/payment-receipt";
export const PHASE9_STOCK_TRANSFER_ROUTE = "POST /api/stock-transfers";
// Stock-item master edits (owner policy 2026-11-02): bulk edits and update-by-code imports.
export const PHASE9_STOCK_ITEM_EDIT_STATIC_ROUTES = Object.freeze([
  "POST /api/stock-items/bulk-update-prices",
  "POST /api/stock-items/bulk-assign-category",
  "POST /api/stock-items/bulk-rename",
  "POST /api/stock-items/bulk-update-uom",
  "POST /api/stock-items/update-categories",
  "POST /api/stock-items/update-names-by-code",
  "POST /api/stock-items/import-barcodes",
  "POST /api/stock-items/import-opening-balances",
]);
export const PHASE9_STOCK_ITEM_CREATE_ROUTE = "POST /api/stock-items";
// Plan batch 3: changes to existing stock transfers (edit, finalize/approve,
// revision, revision approve/reject). Each handler records the change for the
// cloud; the voucher finalize route refuses non-transfer vouchers on the LAN.
const PHASE9_TRANSFER_ID_PATH = /^\/api\/stock-transfers\/(?:[1-9][0-9]{0,9}|:id)$/;
const PHASE9_TRANSFER_APPROVE_PATH = /^\/api\/stock-transfers\/(?:[1-9][0-9]{0,9}|:id)\/approve$/;
const PHASE9_TRANSFER_REVISIONS_PATH = /^\/api\/stock-transfers\/(?:[1-9][0-9]{0,9}|:transferId)\/revisions$/;
const PHASE9_REVISION_REVIEW_PATH = /^\/api\/stock-transfer-revisions\/(?:[1-9][0-9]{0,9}|:id)\/(approve|reject)$/;
const PHASE9_TRANSFER_IMPORT_ROUTES = new Set(
  ["parse", "validate", "import", "parse-multi-source", "validate-multi-source", "import-multi-source"].map(
    (step) => `/api/stock-transfer-import/${step}`
  )
);
const PHASE9_LOCATION_IMPORT_PATH = /^\/api\/locations\/(?:[1-9][0-9]{0,9}|:locationId)\/import-inventory$/;
const PHASE9_VOUCHER_FINALIZE_PATH = /^\/api\/vouchers\/(?:[1-9][0-9]{0,9}|:id)\/finalize$/;
export const PHASE9_STOCK_ITEM_PATH = /^\/api\/stock-items\/(?:[1-9][0-9]{0,9}|:id)$/;
export const PHASE9_STOCK_ITEM_LOCATION_PRICES_PATH = /^\/api\/stock-items\/(?:[1-9][0-9]{0,9}|:id)\/location-prices$/;
// A numeric container id, or the manifest template ":id" (which the route itself rejects as invalid).
// POS sale edits (returns/corrections): PUT is canonical, PATCH the alias.
export const PHASE9_POS_SALE_EDIT_PATH = /^\/api\/vouchers\/(?:[1-9][0-9]{0,9}|:id)\/sales$/;
// POS sale cancellation: the voucher delete route (sales only, checked in the route).
export const PHASE9_VOUCHER_DELETE_PATH = /^\/api\/vouchers\/(?:[1-9][0-9]{0,9}|:id)$/;
export const PHASE9_RECEIVING_OFFLOAD_PATH = /^\/api\/containers\/(?:[1-9][0-9]{0,9}|:id)\/offload$/;

// No module without atomic capture and validated replay is implicitly enabled
// by a one-time operator primary acknowledgement. Add routes only after
// end-to-end cloud acceptance tests, not when merely adding a UI queue.
const LAN_PRIMARY_CAPTURE_ALLOWLIST = new Set([
  "POST /api/vouchers/with-entries",
  // Phase 9: atomic pressing.confirmation.v1 capture -> signed stage ->
  // exactly-once cloud apply with conflict register -> verified LAN receipt.
  PHASE9_PRESSING_CONFIRM_ROUTE,
  // Phase 9 (owner policy 2026-11-01): atomic stock.quick-adjust.v1 capture,
  // replayed in the cloud as a quantity delta; below-zero results are held
  // for an Admin/Developer decision, never applied or dropped silently.
  PHASE9_STOCK_ADJUST_ROUTE,
  // Phase 9 (owner policy 2026-11-01): offline POS cash sales in USD with a
  // LAN invoice series, replayed through the sale service on clientSaleId.
  PHASE9_POS_SALE_ROUTE,
  // Phase 9 (owner policy 2026-11-01): files up to 10 MB; the record syncs
  // first, then the SHA-256-verified bytes.
  PHASE9_ATTACHMENT_UPLOAD_ROUTE,
  // Phase 9 (owner policy 2026-11-02): supplier, customer and bank payments
  // and receipts, replayed through the same posting code at the LAN rate.
  PHASE9_PAYMENT_RECEIPT_ROUTE,
  // Phase 9 (owner policy 2026-11-02): new stock transfers, replayed through
  // the same transfer code on the LAN request id; a cloud shortfall is held.
  PHASE9_STOCK_TRANSFER_ROUTE,
  // Phase 9 (owner policy 2026-11-02): stock-item master edits of existing
  // items, replayed field by field; a field the cloud changed is held.
  ...PHASE9_STOCK_ITEM_EDIT_STATIC_ROUTES,
]);

/** Approved parameterised captures: POST /api/containers/<id>/offload (quantity receipts). */
export function phase9ApprovedCaptureRoute(method, path) {
  const key = `${String(method).toUpperCase()} ${path}`;
  if (LAN_PRIMARY_CAPTURE_ALLOWLIST.has(key)) return key;
  const verb = String(method).toUpperCase();
  // Owner policy 2026-11-02: offline offload edits (PATCH) are recorded too.
  if ((verb === "POST" || verb === "PATCH") && PHASE9_RECEIVING_OFFLOAD_PATH.test(path)) {
    return `${verb} /api/containers/:id/offload`;
  }
  if ((verb === "PUT" || verb === "PATCH") && PHASE9_POS_SALE_EDIT_PATH.test(path)) {
    return `${verb} /api/vouchers/:id/sales`;
  }
  if (verb === "DELETE" && PHASE9_VOUCHER_DELETE_PATH.test(path)) return "DELETE /api/vouchers/:id";
  if (verb === "PATCH" && PHASE9_STOCK_ITEM_PATH.test(path)) return "PATCH /api/stock-items/:id";
  // Plan batch 2: new items and deletes of unused items, recorded for the cloud.
  if (verb === "DELETE" && PHASE9_STOCK_ITEM_PATH.test(path)) return "DELETE /api/stock-items/:id";
  if (key === PHASE9_STOCK_ITEM_CREATE_ROUTE) return key;
  if (verb === "PUT" && PHASE9_TRANSFER_ID_PATH.test(path)) return "PUT /api/stock-transfers/:id";
  if (verb === "POST" && PHASE9_TRANSFER_APPROVE_PATH.test(path)) return "POST /api/stock-transfers/:id/approve";
  if (verb === "POST" && PHASE9_TRANSFER_REVISIONS_PATH.test(path)) {
    return "POST /api/stock-transfers/:transferId/revisions";
  }
  if (verb === "POST" && PHASE9_VOUCHER_FINALIZE_PATH.test(path)) return "POST /api/vouchers/:id/finalize";
  // Plan batch 3: the Excel transfer import (parse and validate only read the
  // spreadsheet; import records an ordinary offline transfer).
  if (verb === "POST" && PHASE9_TRANSFER_IMPORT_ROUTES.has(path)) return key;
  // Plan batch 3: the inventory import, each row recorded as a quantity change.
  if (verb === "POST" && PHASE9_LOCATION_IMPORT_PATH.test(path)) {
    return "POST /api/locations/:locationId/import-inventory";
  }
  const review = verb === "POST" ? PHASE9_REVISION_REVIEW_PATH.exec(path) : null;
  if (review) return `POST /api/stock-transfer-revisions/:id/${review[1]}`;
  if (verb === "POST" && PHASE9_STOCK_ITEM_LOCATION_PRICES_PATH.test(path)) {
    return "POST /api/stock-items/:id/location-prices";
  }
  return null;
}

// Phase 10 operator controls (Admin/Owner pause/resume on the factory server;
// Admin/Developer conflict decisions on the cloud operator console). Each
// writes only through a DBA-owned database function that re-checks the user;
// the route itself refuses unless the server is configured for it.
export const PHASE10_SYNC_CONTROL_ROUTE = "POST /api/edge/operator/sync-control";
export const PHASE10_CONFLICT_DECISION_ROUTE = "POST /api/edge/operator/conflicts/decide";

/** The owner-approved plan batch each gated offline route belongs to. */
export const PHASE9_PLAN_BATCH_ROUTES = Object.freeze(
  new Map([
    ["POST /api/stock-items", 2],
    ["DELETE /api/stock-items/:id", 2],
    ["PUT /api/stock-transfers/:id", 3],
    ["POST /api/stock-transfers/:id/approve", 3],
    ["POST /api/vouchers/:id/finalize", 3],
    ["POST /api/stock-transfers/:transferId/revisions", 3],
    ["POST /api/stock-transfer-revisions/:id/approve", 3],
    ["POST /api/stock-transfer-revisions/:id/reject", 3],
    ["POST /api/locations/:locationId/import-inventory", 3],
    ...["parse", "validate", "import", "parse-multi-source", "validate-multi-source", "import-multi-source"].map(
      (step) => [`POST /api/stock-transfer-import/${step}`, 3]
    ),
  ])
);

/** Null when the route belongs to no gated batch. */
export function phase9PlanBatchOf(routeKey) {
  return PHASE9_PLAN_BATCH_ROUTES.get(routeKey) ?? null;
}

export function edgeBlocksWrite(config, method, path) {
  const verb = String(method).toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(verb)) return false;
  if (SAFE_SESSION_WRITES.has(`${verb} ${path}`)) return false;
  if (config.mode === "lan" && `${verb} ${path}` === PHASE10_SYNC_CONTROL_ROUTE) return false;
  if (config.mode === "cloud" && `${verb} ${path}` === PHASE10_CONFLICT_DECISION_ROUTE) return false;
  if (config.mode === "cloud") return config.writeMode === "fenced";
  if (!config.primary) return true;
  const route = phase9ApprovedCaptureRoute(verb, path);
  if (route === null) return true;
  const batch = phase9PlanBatchOf(route);
  return batch !== null && !(config.approvedPlanBatches ?? []).includes(batch);
}

export function edgeStatusPayload(config, databaseProvisioned = false) {
  return {
    mode: config.mode,
    siteId: config.siteId,
    writeMode: config.writeMode,
    databaseProvisioned: Boolean(databaseProvisioned),
    // This indicator never asserts cloud replication is configured or complete.
    cloudReplication: "not-configured",
  };
}

export const EDGE_PRIMARY_ACK = PRIMARY_ACK;
export const CLOUD_WRITER_FENCE_ACK = CLOUD_FENCE_ACK;

/** LAN edge must never run cloud-derived post-startup repair/cleanup jobs. */
export function shouldStartEdgeBackgroundJobs(config) {
  return config.mode === "cloud" && config.writeMode !== "fenced";
}
