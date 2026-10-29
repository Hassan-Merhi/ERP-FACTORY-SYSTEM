#!/usr/bin/env node
/** Non-destructive Phase 6 release evidence check. No ERP mutation or database access. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_DRILLS = Object.freeze([
  'exact-head-ci', 'independent-security-review', 'phase4-sync-verified',
  'phase5-conflict-resolution', 'cloud-single-writer-fence',
  'lan-single-writer-fence', 'two-laptop-wan-outage',
  'offline-auth-permissions', 'interrupted-sync-retry',
  'idempotent-posting-retry', 'inventory-ledger-reconciliation',
  'attachments-reconciliation', 'power-loss-recovery',
  'encrypted-backup-isolated-restore', 'cloud-failback-reconciliation',
]);
const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateHttpsOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password &&
      u.pathname === '/' && !u.search && !u.hash && origin === u.origin;
  } catch { return false; }
}

function safeEvidenceName(name) {
  return typeof name === 'string' && name.length <= 180 &&
    /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:json|txt|log|md)$/.test(name);
}

async function verifyFile(root, entry) {
  const file = path.resolve(root, entry.file);
  const resolvedRoot = await realpath(root);
  // Both lexical and canonical boundaries are required: no parent traversal or symlink escapes.
  if (!file.startsWith(root + path.sep)) throw new Error('outside evidence root');
  const resolvedFile = await realpath(file);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) throw new Error('symlink escapes evidence root');
  const info = await stat(resolvedFile);
  if (!info.isFile() || info.size === 0 || info.size > MAX_EVIDENCE_BYTES) throw new Error('invalid evidence size');
  const actual = createHash('sha256').update(await readFile(resolvedFile)).digest('hex');
  if (actual !== entry.sha256.toLowerCase()) throw new Error('sha256 mismatch');
}

/** Report is a gate, not a cryptographic proof of a human attestation. */
export async function checkReleaseManifest(manifest, { evidenceRoot, now = Date.now() } = {}) {
  const blockers = [];
  const fail = (code, detail) => blockers.push({ code, detail });
  if (!isPlainObject(manifest) || manifest.version !== 1 || manifest.environment !== 'staging') {
    fail('INVALID_MANIFEST', 'Expected version 1 and environment staging; production is never auto-approved.');
    return { ok: false, blockers };
  }
  if (!SHA.test(manifest.releaseSha ?? '')) fail('INVALID_RELEASE_SHA', 'Use the exact 40-character release commit.');
  if (!UUID.test(manifest.siteId ?? '')) fail('INVALID_SITE_ID', 'Use the LAN edge site UUID.');
  if (!validateHttpsOrigin(manifest.edgeOrigin)) fail('INVALID_EDGE_ORIGIN', 'Require an exact HTTPS origin without credentials, path, query, or fragment.');
  if (!['read-only', 'lan-primary'].includes(manifest.expectedWriteMode)) {
    fail('INVALID_WRITE_MODE', 'Declare the expected LAN writer mode explicitly.');
  }
  if (!isPlainObject(manifest.drills)) fail('MISSING_DRILLS', 'All required drills need evidence.');
  const evidencePaths = new Set();
  for (const key of REQUIRED_DRILLS) {
    const entry = manifest.drills?.[key];
    if (!isPlainObject(entry) || entry.result !== 'pass' || !SHA.test(entry.releaseSha ?? '') ||
        entry.releaseSha.toLowerCase() !== String(manifest.releaseSha).toLowerCase() ||
        !HASH.test(entry.sha256 ?? '') || !safeEvidenceName(entry.file)) {
      fail('DRILL_MISSING_OR_INVALID', key);
      continue;
    }
    if (evidencePaths.has(entry.file)) {
      fail('REUSED_EVIDENCE_FILE', key);
      continue;
    }
    evidencePaths.add(entry.file);
    const recorded = Date.parse(entry.recordedAt);
    if (typeof entry.recordedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(entry.recordedAt) ||
        !Number.isFinite(recorded) || recorded > now || now - recorded > MAX_EVIDENCE_AGE_MS) {
      fail('STALE_OR_INVALID_EVIDENCE', key);
      continue;
    }
    if (!evidenceRoot) {
      fail('EVIDENCE_ROOT_REQUIRED', key);
      continue;
    }
    try { await verifyFile(path.resolve(evidenceRoot), entry); }
    catch (err) { fail('EVIDENCE_INTEGRITY_FAILED', key + ': ' + (err.code ?? err.message)); }
  }
  return { ok: blockers.length === 0, blockers };
}

export async function probeEdge(origin, { siteId, expectedWriteMode, fetcher = fetch } = {}) {
  if (!validateHttpsOrigin(origin)) return [{ code: 'INVALID_EDGE_ORIGIN' }];
  const issues = [];
  for (const [endpoint, check] of [
    ['/api/edge/status', value => value.mode === 'lan' && value.siteId === siteId &&
      value.writeMode === expectedWriteMode && value.databaseProvisioned === true &&
      value.cloudReplication === 'verified'],
    ['/api/health/ready', value => value?.status === 'ready' && value.listening === true &&
      value.shuttingDown === false && value.environmentValid === true &&
      value.database?.ok === true && value.database.schema?.ok === true &&
      value.database.edgeDataProvisioned !== false],
  ]) {
    try {
      const response = await fetcher(origin + endpoint, {
        method: 'GET', redirect: 'manual', cache: 'no-store',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) {
        issues.push({ code: 'EDGE_PROBE_FAILED', endpoint, status: response.status });
        continue;
      }
      const body = await response.text();
      if (body.length > 8192 || !check(JSON.parse(body))) {
        issues.push({ code: 'EDGE_PROBE_UNSAFE_STATE', endpoint });
      }
    } catch {
      issues.push({ code: 'EDGE_PROBE_UNREACHABLE', endpoint });
    }
  }
  return issues;
}

export async function certify(manifest, options = {}) {
  const report = await checkReleaseManifest(manifest, options);
  if (!report.ok) return report; // Never probe a potentially unvalidated URL.
  if (options.noNetwork) return { ok: false, blockers: [{ code: 'LIVE_PROBE_REQUIRED' }] };
  const blockers = await probeEdge(manifest.edgeOrigin, {
    siteId: manifest.siteId, expectedWriteMode: manifest.expectedWriteMode,
    fetcher: options.fetcher,
  });
  return { ok: blockers.length === 0, blockers };
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/edge/certify-offline-phase6.mjs --manifest evidence.json --evidence-root private-evidence-dir [--output report.json] [--no-network]');
    return;
  }
  const option = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  const manifestPath = option('--manifest');
  const evidenceRoot = option('--evidence-root');
  if (!manifestPath || !evidenceRoot) throw new Error('Both --manifest and --evidence-root are mandatory');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const report = await certify(manifest, { evidenceRoot, noNetwork: args.includes('--no-network') });
  const summary = { ...report, releaseSha: manifest.releaseSha ?? null, siteId: manifest.siteId ?? null };
  if (option('--output')) await writeFile(option('--output'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => { console.error('Phase 6 certification blocked: ' + err.message); process.exitCode = 1; });
}
