#!/usr/bin/env node
// Full offline mode (Phase A3b): the sync process the desktop app starts.
//
// Environment (set by the desktop app, never by the cloud):
//   PC_LOCAL_DATABASE_URL  the PC's own PostgreSQL (embedded, 127.0.0.1)
//   PC_SYNC_CLOUD_URL      https://www.hmdinternationalgroup.com
//   PC_SYNC_COOKIE         optional saved session cookie
//   PC_SYNC_INTERVAL_MS    optional, default 60000
//
// Commands arrive as JSON lines on stdin:
//   {"cmd":"login","username":"...","password":"..."}   sign in and remember on this PC
//   {"cmd":"sync"}                                      sync now
//   {"cmd":"approve"|"discard","operationId":"..."}     decide a held entry (approve: Admin/Developer only)
//   {"cmd":"stop"}
// Events leave as JSON lines on stdout: status, cookie, login, error. The
// password never appears in an event or a log line.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadPcSyncPolicy } from "../../../server/offline/pcSync/tablePolicy.mjs";
import { createCloudClient } from "./cloudClient.mjs";
import { connectCloudAccount } from "./connectAccount.mjs";
import { prepareLocalDatabase, readLocalState } from "./localStore.mjs";
import { pcSyncFreshness } from "./syncAgent.mjs";
import { decideUnconfirmed, outboxSummary, resolveConflict, syncCycle } from "./outbox.mjs";

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

export function buildLocalDatabase(databaseUrl) {
  const migrate = fileURLToPath(new URL("../../db/migrate.mjs", import.meta.url));
  execFileSync(process.execPath, [migrate, "apply"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DATABASE_URL: databaseUrl,
      PGSSLMODE: "disable",
      MIGRATION_CONFIRMATION: "APPLY_SCHEMA_MIGRATIONS",
    },
    stdio: "pipe",
  });
}

/** The existing cloud customers a held new customer looks like (at most 3), for the merge choice. */
function heldCustomerCandidates(row) {
  if (row.code !== "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE" || !Array.isArray(row.detail?.candidates)) return [];
  return row.detail.candidates
    .filter((c) => Number.isSafeInteger(c?.customerId) && c.customerId > 0)
    .slice(0, 3)
    .map((c) => ({ customerId: c.customerId, code: String(c.code ?? ""), legalName: String(c.legalName ?? "") }));
}

async function main() {
  const databaseUrl = process.env.PC_LOCAL_DATABASE_URL;
  const cloudUrl = process.env.PC_SYNC_CLOUD_URL;
  if (!databaseUrl || !cloudUrl) {
    send({ event: "error", code: "PC_AGENT_NOT_CONFIGURED" });
    process.exit(2);
  }
  if (!["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) {
    send({ event: "error", code: "PC_AGENT_DATABASE_NOT_LOCAL" });
    process.exit(2);
  }
  const interval = Math.max(Number(process.env.PC_SYNC_INTERVAL_MS) || 60_000, 5_000);

  buildLocalDatabase(databaseUrl);
  const local = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await local.connect();
  await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  let cloud = createCloudClient(cloudUrl, { cookie: process.env.PC_SYNC_COOKIE || "" });

  let busy = Promise.resolve();
  const serial = (work) => (busy = busy.then(work, work));

  async function status(extra = {}) {
    const state = await readLocalState(local);
    send({
      event: "status",
      copyComplete: state.copy_complete,
      lastSyncAt: state.last_sync_at,
      freshness: pcSyncFreshness(state.last_sync_at),
      outbox: await outboxSummary(local),
      conflicts: (
        await local.query(
          `SELECT operation_id, kind, code, overridable, captured_at, status, detail FROM pc_local.outbox
            WHERE status IN ('conflict', 'unconfirmed') ORDER BY id LIMIT 20`
        )
      ).rows.map((r) => ({
        operationId: r.operation_id,
        kind: r.kind,
        code: r.code,
        overridable: r.overridable,
        capturedAt: r.captured_at,
        unconfirmed: r.status === "unconfirmed",
        // A customer held as a possible duplicate: the existing ones it may be.
        candidates: heldCustomerCandidates(r),
      })),
      ...extra,
    });
  }

  async function syncNow() {
    if (!cloud.cookie()) return status({ needsLogin: true });
    try {
      const report = await syncCycle(local, cloud);
      await status({ report });
    } catch (error) {
      const code = error?.code || "PC_AGENT_SYNC_FAILED";
      const needsLogin = error?.detail?.status === 401 || code === "PC_SYNC_LOGIN_EXPIRED";
      send({ event: "error", code, needsLogin });
      await status({ needsLogin });
    }
  }

  async function login(username, password) {
    try {
      const connected = await connectCloudAccount(local, cloudUrl, username, password);
      cloud = connected.cloud;
      const reset = connected.copyReset;
      send({ event: "login", ok: true, copyReset: reset });
      send({ event: "cookie", cookie: cloud.cookie() });
      await syncNow();
    } catch (error) {
      send({ event: "login", ok: false, code: error?.code || "PC_SYNC_LOGIN_REFUSED" });
    }
  }

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return send({ event: "error", code: "PC_AGENT_COMMAND_INVALID" });
    }
    if (command?.cmd === "login") serial(() => login(command.username, command.password));
    else if (command?.cmd === "sync") serial(syncNow);
    else if ((command?.cmd === "approve" || command?.cmd === "discard") && typeof command.operationId === "string") {
      serial(async () => {
        try {
          const unconfirmed = await local.query(
            "SELECT 1 FROM pc_local.outbox WHERE operation_id = $1::uuid AND status = 'unconfirmed'",
            [command.operationId]
          );
          if (unconfirmed.rowCount) {
            // An interrupted save: "approve" means send it, "discard" drops it here.
            await decideUnconfirmed(local, command.operationId, command.cmd === "approve" ? "send" : "discard");
          } else {
            const mergeInto = Number.isSafeInteger(command.mergeInto) ? command.mergeInto : null;
            await resolveConflict(local, cloud, command.operationId, command.cmd, { mergeInto });
          }
          send({ event: "decision", ok: true, operationId: command.operationId });
        } catch (error) {
          send({ event: "decision", ok: false, operationId: command.operationId, code: error?.code });
        }
        await status();
      });
    }
    else if (command?.cmd === "stop") serial(async () => process.exit(0));
    else send({ event: "error", code: "PC_AGENT_COMMAND_INVALID" });
  });
  lines.on("close", () => serial(async () => process.exit(0)));

  await serial(syncNow);
  setInterval(() => serial(syncNow), interval).unref();
  // Keep running while stdin is open.
  process.stdin.resume();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    send({ event: "error", code: error?.code || "PC_AGENT_START_FAILED" });
    process.exit(1);
  });
}
