// Full offline mode (Phase A3b): the PC's local copy inside the desktop app.
//
// Off unless <userData>/offline-pc.json has "enabled": true. When on, the app
// starts, all bound to 127.0.0.1 only:
//   1. an embedded PostgreSQL in <userData>/pc-database,
//   2. the sync agent (scripts/pc-sync/local/run-agent.mjs), which builds the
//      schema from migrations/ and keeps the copy equal to the cloud,
//   3. the ERP server against that database with OFFLINE_PC_LOCAL_MODE=read-only.
// The window keeps using the cloud; when the cloud cannot be reached it opens
// the local copy instead of the offline page.
//
// Secrets (database password, session secret, cloud cookie) are stored with the
// operating system's protected storage (Electron safeStorage).

const { app, safeStorage } = require('electron');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pathToFileURL } = require('url');

const DEFAULTS = { enabled: false, entries: false, databasePort: 55439, serverPort: 5179 };

const USER_FILE = /^[a-z0-9][a-z0-9-]{0,40}\.(json|bin)$|^pc-database$/;

/** One of this app's own files (fixed names only) in the user-data folder. */
function userFile(name) {
  if (!USER_FILE.test(name)) throw new Error('Invalid offline-copy file name');
  return `${app.getPath('userData')}${path.sep}${name}`;
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(userFile('offline-pc.json'), 'utf8'));
    return {
      enabled: parsed.enabled === true,
      // Phase B: offline entries (needs OFFLINE_BROWSER_SYNC_ENABLED=1 on the cloud).
      entries: parsed.enabled === true && parsed.entries === true,
      databasePort: Number.isInteger(parsed.databasePort) ? parsed.databasePort : DEFAULTS.databasePort,
      serverPort: Number.isInteger(parsed.serverPort) ? parsed.serverPort : DEFAULTS.serverPort,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** A secret kept encrypted on disk; created on first use. */
function secret(name, create = () => crypto.randomBytes(32).toString('hex')) {
  const file = userFile(`${name}.bin`);
  if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(fs.readFileSync(file));
  }
  const value = create();
  if (value && safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(value));
  return value;
}

function saveSecret(name, value) {
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(userFile(`${name}.bin`), safeStorage.encryptString(value));
}

/** Where the bundled ERP server lives (staged by desktop/scripts/stage-local-server.mjs). */
function serverRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'erp-server')
    : path.join(__dirname, '..', 'build', 'erp-server');
}

function createLocalMode({ cloudUrl, onStatus = () => {} }) {
  const config = readConfig();
  let database = null;
  let agent = null;
  let server = null;
  let ready = false;
  let lastStatus = null;

  const localUrl = `http://127.0.0.1:${config.serverPort}`;

  async function startDatabase(password) {
    // Staged next to the server for this operating system (stage-local-server.mjs).
    const entry = path.join(serverRoot(), 'node_modules', 'embedded-postgres', 'dist', 'index.js');
    const { default: EmbeddedPostgres } = await import(pathToFileURL(entry).href);
    const dataDir = userFile('pc-database');
    database = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password,
      port: config.databasePort,
      persistent: true,
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    });
    if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await database.initialise();
    await database.start();
    const client = database.getPgClient();
    await client.connect();
    try {
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'erp_pc'");
      if (exists.rowCount === 0) await database.createDatabase('erp_pc');
    } finally {
      await client.end();
    }
    return `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${config.databasePort}/erp_pc`;
  }

  function startAgent(databaseUrl) {
    const root = serverRoot();
    agent = fork(path.join(root, 'scripts', 'pc-sync', 'local', 'run-agent.mjs'), [], {
      cwd: root,
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PC_LOCAL_DATABASE_URL: databaseUrl,
        PC_SYNC_CLOUD_URL: cloudUrl,
        PC_SYNC_COOKIE: secret('cloud-cookie', () => '') || '',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    readline.createInterface({ input: agent.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'cookie' && typeof event.cookie === 'string') saveSecret('cloud-cookie', event.cookie);
      if (event.event === 'status') {
        lastStatus = event;
        if (event.copyComplete && !server) startServer(databaseUrl);
      }
      onStatus(event);
    });
    agent.on('exit', () => {
      agent = null;
    });
  }

  function startServer(databaseUrl) {
    const root = serverRoot();
    server = fork(path.join(root, 'dist', 'index.js'), [], {
      cwd: root,
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(config.serverPort),
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
        SESSION_SECRET: secret('session-secret'),
        OFFLINE_PC_LOCAL_MODE: config.entries ? 'entry' : 'read-only',
        ENABLE_SCHEDULERS: 'false',
        OFFLINE_PC_SYNC_ENABLED: '0',
      },
      stdio: 'ignore',
    });
    server.on('exit', () => {
      server = null;
      ready = false;
    });
    ready = true;
  }

  return {
    enabled: config.enabled,
    entries: config.entries,
    localUrl,
    isLocalUrl(url) {
      try {
        return new URL(url).origin === localUrl;
      } catch {
        return false;
      }
    },
    /** True once the copy is complete and the local server was started. */
    ready: () => ready,
    status: () => lastStatus,
    async start() {
      if (!config.enabled) return;
      const databaseUrl = await startDatabase(secret('database-password'));
      startAgent(databaseUrl);
    },
    connect(username, password) {
      if (!agent) return false;
      agent.stdin.write(`${JSON.stringify({ cmd: 'login', username, password })}\n`);
      return true;
    },
    decide(operationId, decision) {
      if (!agent || (decision !== 'approve' && decision !== 'discard')) return;
      agent.stdin.write(`${JSON.stringify({ cmd: decision, operationId })}\n`);
    },
    syncNow() {
      if (agent) agent.stdin.write(`${JSON.stringify({ cmd: 'sync' })}\n`);
    },
    async stop() {
      if (agent) agent.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
      if (server) server.kill();
      if (database) await database.stop().catch(() => undefined);
    },
  };
}

module.exports = { createLocalMode, readConfig };
