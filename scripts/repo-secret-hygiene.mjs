import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const mode = process.argv.includes('--history') ? 'history' : 'tree';
const maxTextBytes = 2_000_000;

const detectors = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI project/service key', /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
  ['Stripe live secret', /\bsk_live_[0-9A-Za-z]{16,}\b/],
];

const databaseUrlPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]+/gi;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const forbiddenSecretFiles = /(^|\/)(?:\.env(?:\..+)?|keystore\.properties|[^/]+\.(?:jks|keystore|pem|key))$/i;
const allowedTrackedSecretLikeFiles = new Set([
  '.env.example',
  '.env.production',
  'client/.env.production',
  'client/.env.capacitor',
  'android/keystore.properties.example',
]);

function remoteCredentialedDatabaseUrl(text) {
  for (const match of text.matchAll(databaseUrlPattern)) {
    const candidate = match[0].replace(/[),;]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.username && url.password && !loopbackHosts.has(url.hostname.toLowerCase())) return true;
    } catch {
      if (/\/\/[^\s:/@]+:[^\s/@]+@/.test(candidate)) return true;
    }
  }
  return false;
}

function labelsFor(text) {
  const labels = [];
  for (const [label, pattern] of detectors) {
    if (pattern.test(text)) labels.push(label);
  }
  if (remoteCredentialedDatabaseUrl(text)) labels.push('credentialed remote database URL');
  return labels;
}

function isForbiddenSecretFile(path) {
  return forbiddenSecretFiles.test(path) && !allowedTrackedSecretLikeFiles.has(path);
}

function fail(findings, scope) {
  if (!findings.length) {
    console.log(`Repository secret hygiene passed (${scope}).`);
    return;
  }
  console.error(`Repository secret hygiene failed (${scope}): ${findings.length} possible exposure location(s).`);
  console.error('Secret values are intentionally never printed. Rotate/revoke any credential that was ever real before removing the finding.');
  for (const finding of findings.slice(0, 80)) console.error(`- ${finding}`);
  if (findings.length > 80) console.error(`- ...and ${findings.length - 80} more`);
  process.exitCode = 1;
}

async function scanTree() {
  const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(listed.stderr || 'git ls-files failed');
  const files = listed.stdout.split('\0').filter(Boolean);
  const findings = [];

  for (const path of files) {
    if (isForbiddenSecretFile(path)) {
      findings.push(`${path}: tracked secret-bearing file type`);
      continue;
    }
    let info;
    try { info = await stat(path); } catch { continue; }
    if (!info.isFile() || info.size > maxTextBytes) continue;
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    for (const label of labelsFor(text)) findings.push(`${path}: possible ${label}`);
  }

  fail([...new Set(findings)], 'current tracked tree');
}

async function scanHistory() {
  const findings = new Set();
  const git = spawn('git', ['log', '--all', '--format=@@COMMIT@@%H', '--name-status', '-p', '--no-ext-diff', '--no-renames', '--', '.', ':(exclude)package-lock.json', ':(exclude)scripts/repo-secret-hygiene.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  git.stderr.setEncoding('utf8');
  git.stderr.on('data', (chunk) => { stderr += chunk; });

  let commit = 'unknown';
  let path = 'unknown';
  const lines = createInterface({ input: git.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith('@@COMMIT@@')) {
      commit = line.slice('@@COMMIT@@'.length).trim() || 'unknown';
      path = 'unknown';
      continue;
    }

    const diff = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff) {
      path = diff[2];
      if (isForbiddenSecretFile(path)) findings.add(`${commit.slice(0, 12)} ${path}: secret-bearing file appeared in history`);
      continue;
    }

    const nameStatus = line.match(/^[ACDMRTUXB]\d*\s+(.+)$/);
    if (nameStatus) {
      const candidate = nameStatus[1].split('\t').at(-1)?.trim();
      if (candidate && isForbiddenSecretFile(candidate)) findings.add(`${commit.slice(0, 12)} ${candidate}: secret-bearing file appeared in history`);
      continue;
    }

    if (!(line.startsWith('+') || line.startsWith('-'))) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    for (const label of labelsFor(line.slice(1))) findings.add(`${commit.slice(0, 12)} ${path}: possible ${label}`);
  }

  const exitCode = await new Promise((resolve, reject) => {
    git.on('error', reject);
    git.on('close', resolve);
  });
  if (exitCode !== 0) throw new Error(stderr || `git log exited ${exitCode}`);
  fail([...findings], 'reachable Git history');
}

if (mode === 'history') await scanHistory();
else await scanTree();
