/**
 * Runs inside a real Electron main process and loads desktop/main.js unchanged.
 *
 * Chromium is told to resolve the production host to a local HTTPS server and
 * every other host to "not found", so the shell believes it is talking to
 * production while nothing leaves this machine. shell.openExternal is replaced
 * with a recorder so no system browser is ever started.
 *
 * Started by tests/e2e/desktop-shell/run.mjs, which supplies the certificate
 * and reads the result file.
 */
const { app, BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const APP_ORIGIN = "https://www.hmdinternationalgroup.com";
const APP_HOST = "www.hmdinternationalgroup.com";
const scenario = process.env.DESKTOP_SHELL_SCENARIO;
const resultPath = process.env.DESKTOP_SHELL_RESULT;
const port = Number(process.env.DESKTOP_SHELL_PORT);
const tls = {
  key: fs.readFileSync(process.env.DESKTOP_SHELL_TLS_KEY),
  cert: fs.readFileSync(process.env.DESKTOP_SHELL_TLS_CERT),
};

const STUB_PAGE = `<!doctype html>
<html><head><title>Hosted page title</title></head>
<body>
  <h1 id="app-root">ERP stub</h1>
  <iframe id="broken-frame" src="https://frame-that-cannot-resolve.invalid/embed"></iframe>
</body></html>`;

const checks = [];
const openedExternally = [];
const failedLoads = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
}

function finish(error) {
  const failed = checks.filter((entry) => !entry.ok);
  const result = {
    scenario,
    ok: !error && failed.length === 0 && checks.length > 0,
    error: error ? String(error.stack || error) : null,
    checks,
    openedExternally,
    failedLoads,
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

async function waitFor(description, probe, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = https.createServer(tls, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(STUB_PAGE);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function mainWindow() {
  return BrowserWindow.getAllWindows()[0];
}

// Compare whole origins and whole URLs: a prefix or substring match would also
// accept look-alike hosts, which is the mistake this harness exists to catch.
function isOnAppOrigin(url) {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function wasOpenedExternally(url) {
  return openedExternally.some((opened) => opened === url);
}

function inPage(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

async function loadedOnApp(win) {
  await waitFor("the application page", async () => {
    if (!isOnAppOrigin(win.webContents.getURL()) || win.webContents.isLoading()) return false;
    return inPage(win, "Boolean(document.getElementById('app-root'))").catch(() => false);
  });
}

async function onlineScenario() {
  await startServer();
  require(path.resolve(__dirname, "../../../desktop/main.js"));

  const win = await waitFor("the main window", async () => mainWindow());
  await loadedOnApp(win);

  check("loads the production origin", win.webContents.getURL() === `${APP_ORIGIN}/`, win.webContents.getURL());
  check("opens exactly one window", BrowserWindow.getAllWindows().length === 1, BrowserWindow.getAllWindows().length);
  check("keeps the product window title", win.getTitle() === "ERP Warehouse", win.getTitle());

  const prefs = win.webContents.getLastWebPreferences();
  check("context isolation is on", prefs.contextIsolation === true, prefs.contextIsolation);
  check("node integration is off", prefs.nodeIntegration === false, prefs.nodeIntegration);
  check("web security is on", prefs.webSecurity === true, prefs.webSecurity);

  const page = await inPage(
    win,
    `({
      require: typeof require,
      process: typeof process,
      module: typeof module,
      bridgeKeys: Object.keys(window.electronAPI || {}).sort(),
      platform: window.electronAPI && window.electronAPI.platform,
    })`
  );
  check("the page cannot reach require", page.require === "undefined", page.require);
  check("the page cannot reach process", page.process === "undefined", page.process);
  check("the page cannot reach module", page.module === "undefined", page.module);
  check(
    "the bridge exposes only platform and version",
    JSON.stringify(page.bridgeKeys) === JSON.stringify(["platform", "version"]),
    page.bridgeKeys
  );
  check("the bridge reports the real platform", page.platform === process.platform, page.platform);

  await waitFor("the embedded frame failure", async () => failedLoads.some((entry) => entry.isMainFrame === false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    "a failed embedded frame leaves the application on screen",
    win.webContents.getURL() === `${APP_ORIGIN}/`,
    win.webContents.getURL()
  );

  const lookalike = "https://www.hmdinternationalgroup.com.example.net/login";
  await inPage(win, `void window.open(${JSON.stringify(lookalike)})`);
  await waitFor("the look-alike popup hand-off", async () => wasOpenedExternally(lookalike));
  check(
    "a look-alike popup goes to the system browser, not a new window",
    BrowserWindow.getAllWindows().length === 1,
    BrowserWindow.getAllWindows().length
  );

  const beforeFile = openedExternally.length;
  await inPage(win, "void window.open('file:///etc/passwd')");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    "a file: popup is dropped without reaching the operating system",
    BrowserWindow.getAllWindows().length === 1 && openedExternally.length === beforeFile,
    { windows: BrowserWindow.getAllWindows().length, openedExternally }
  );

  await inPage(win, `void window.open(${JSON.stringify(`${APP_ORIGIN}/print`)})`);
  const child = await waitFor("the same-origin popup", async () =>
    BrowserWindow.getAllWindows().find((candidate) => candidate !== win)
  );
  const childPrefs = child.webContents.getLastWebPreferences();
  check(
    "a same-origin popup opens and stays isolated",
    childPrefs.contextIsolation === true && childPrefs.nodeIntegration === false,
    { contextIsolation: childPrefs.contextIsolation, nodeIntegration: childPrefs.nodeIntegration }
  );
  child.destroy();

  const external = "https://example.org/somewhere";
  await inPage(win, `void (window.location.href = ${JSON.stringify(external)})`);
  await waitFor("the external navigation hand-off", async () => wasOpenedExternally(external));
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    "navigating to another host is blocked and handed to the system browser",
    win.webContents.getURL() === `${APP_ORIGIN}/`,
    win.webContents.getURL()
  );
}

async function offlineScenario() {
  require(path.resolve(__dirname, "../../../desktop/main.js"));

  const win = await waitFor("the main window", async () => mainWindow());
  await waitFor("the offline page", async () => {
    const url = win.webContents.getURL();
    return url.startsWith("file://") && url.endsWith("/desktop/offline.html") && !win.webContents.isLoading();
  });
  check("shows the bundled offline page when the site is unreachable", true, win.webContents.getURL());

  const offline = await inPage(
    win,
    `({
      heading: document.querySelector('h1') && document.querySelector('h1').textContent,
      hasRetry: Boolean(document.querySelector('button')),
      remoteResources: Array.from(document.querySelectorAll('script[src],link[href],img[src]')).length,
      require: typeof require,
    })`
  );
  check("the offline page explains the problem", offline.heading === "No Connection", offline.heading);
  check("the offline page needs no remote resources", offline.remoteResources === 0, offline.remoteResources);
  check("the offline page cannot reach require", offline.require === "undefined", offline.require);
  check("the offline page offers Retry", offline.hasRetry === true, offline.hasRetry);

  await startServer();
  await inPage(win, "document.querySelector('button').click()");
  await loadedOnApp(win);
  check("Retry returns to the application once it is reachable", win.webContents.getURL() === `${APP_ORIGIN}/`);
  check("Retry does not leak to the system browser", openedExternally.length === 0, openedExternally);
}

// Chromium switches must be set before the app is ready.
app.commandLine.appendSwitch("host-resolver-rules", `MAP ${APP_HOST} 127.0.0.1:${port}, MAP * ~NOTFOUND`);
app.commandLine.appendSwitch("ignore-certificate-errors");
// A proxy from the environment would bypass the resolver rules above.
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("no-sandbox");

shell.openExternal = async (url) => {
  openedExternally.push(String(url));
};

app.on("web-contents-created", (_event, contents) => {
  contents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failedLoads.push({ errorCode, errorDescription, validatedURL, isMainFrame });
  });
});

const watchdog = setTimeout(() => finish(new Error("Scenario exceeded 60 seconds")), 60000);

async function portIsFree() {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: "127.0.0.1", port }, () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
}

(async () => {
  if (!(await portIsFree())) throw new Error(`Port ${port} is already in use`);
  if (scenario === "online") await onlineScenario();
  else if (scenario === "offline") await offlineScenario();
  else throw new Error(`Unknown scenario: ${scenario}`);
})()
  .then(() => {
    clearTimeout(watchdog);
    finish(null);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    finish(error);
  });
