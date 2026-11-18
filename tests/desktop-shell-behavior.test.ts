/**
 * Behaviour of the Electron desktop shell (desktop/main.js, desktop/preload.js).
 *
 * The shell is a thin wrapper around the hosted ERP, so what matters is what it
 * refuses: Node access from the page, navigation to other origins, and popups
 * to look-alike hosts. These tests load the real main-process file against a
 * recording stand-in for the `electron` module and drive the handlers it
 * registers. scripts/verify-desktop-shell-launch.cjs covers the same shell in
 * a real Electron process.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Module = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };

const DESKTOP_DIR = path.resolve(import.meta.dirname, "../desktop");
const MAIN_PATH = path.join(DESKTOP_DIR, "main.js");
const PRELOAD_PATH = path.join(DESKTOP_DIR, "preload.js");
const APP_ORIGIN = "https://www.hmdinternationalgroup.com";

type Handler = (...args: any[]) => any;

function emitter() {
  const handlers = new Map<string, Handler[]>();
  return {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    has: (event: string) => (handlers.get(event) ?? []).length > 0,
  };
}

function createElectronStub() {
  const windows: any[] = [];
  let zoom = 1;
  let fullScreen = false;

  class BrowserWindow {
    static getAllWindows = vi.fn(() => windows);
    options: any;
    events = emitter();
    webContentsEvents = emitter();
    windowOpenHandler: Handler | null = null;
    loadURL = vi.fn();
    loadFile = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    setFullScreen = vi.fn((value: boolean) => {
      fullScreen = value;
    });
    isFullScreen = vi.fn(() => fullScreen);
    on = this.events.on;
    once = this.events.once;
    webContents = {
      on: this.webContentsEvents.on,
      setWindowOpenHandler: vi.fn((handler: Handler) => {
        this.windowOpenHandler = handler;
      }),
      openDevTools: vi.fn(),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      getZoomFactor: vi.fn(() => zoom),
      setZoomFactor: vi.fn((value: number) => {
        zoom = value;
      }),
    };
    constructor(options: unknown) {
      this.options = options;
      windows.push(this);
    }
  }

  const appEvents = emitter();
  let ready: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const menu = { template: null as any };

  const electron = {
    app: {
      on: appEvents.on,
      setName: vi.fn(),
      getVersion: vi.fn(() => "9.9.9"),
      quit: vi.fn(),
      whenReady: vi.fn(() => whenReady),
    },
    BrowserWindow,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => {
        menu.template = template;
        return { built: template };
      }),
      setApplicationMenu: vi.fn(),
    },
    shell: { openExternal: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    nativeTheme: {},
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: { send: vi.fn(), invoke: vi.fn(), on: vi.fn() },
  };

  return {
    electron,
    windows,
    appEvents,
    menu,
    zoom: () => zoom,
    async becomeReady() {
      ready();
      await whenReady;
      await Promise.resolve();
    },
  };
}

type Stub = ReturnType<typeof createElectronStub>;

const originalLoad = Module._load;
const originalArgv = process.argv;
let stub: Stub;

function loadShellFile(file: string) {
  delete require.cache[file];
  return require(file);
}

async function startShell(argv: string[] = []) {
  process.argv = ["electron", ".", ...argv];
  loadShellFile(MAIN_PATH);
  await stub.becomeReady();
  return stub.windows[0];
}

function menuItem(menuLabel: string, itemLabel: string) {
  const group = stub.menu.template.find((entry: any) => entry.label === menuLabel);
  const item = group?.submenu.find((entry: any) => entry.label === itemLabel);
  expect(item, `${menuLabel} > ${itemLabel} must exist`).toBeTruthy();
  return item;
}

beforeEach(() => {
  stub = createElectronStub();
  Module._load = function patchedLoad(request: string, ...rest: unknown[]) {
    if (request === "electron") return stub.electron;
    return originalLoad.call(this, request, ...rest);
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Module._load = originalLoad;
  process.argv = originalArgv;
  delete require.cache[MAIN_PATH];
  delete require.cache[PRELOAD_PATH];
  vi.restoreAllMocks();
});

describe("desktop shell window", () => {
  it("opens one isolated window on the production origin and nowhere else", async () => {
    const win = await startShell();

    expect(stub.windows).toHaveLength(1);
    expect(win.loadURL).toHaveBeenCalledTimes(1);
    expect(win.loadURL).toHaveBeenCalledWith(APP_ORIGIN);
    expect(win.options.webPreferences).toEqual({
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("stays hidden until the page is ready, then shows and focuses", async () => {
    const win = await startShell();

    expect(win.options.show).toBe(false);
    expect(win.show).not.toHaveBeenCalled();
    win.events.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the product title whatever the hosted page sets", async () => {
    const win = await startShell();
    const event = { preventDefault: vi.fn() };

    win.events.emit("page-title-updated", event, "Some Remote Title");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.setTitle).toHaveBeenCalledWith("ERP Warehouse");
    expect(stub.electron.app.setName).toHaveBeenCalledWith("ERP Warehouse");
  });

  it("does not open developer tools on a normal start", async () => {
    const win = await startShell();
    expect(win.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it("opens developer tools when started with --dev", async () => {
    const win = await startShell(["--dev"]);
    expect(win.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });
});

describe("desktop shell load failures", () => {
  it("shows the bundled offline page when the main page cannot load", async () => {
    const win = await startShell();

    win.webContentsEvents.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", APP_ORIGIN, true);

    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.loadFile).toHaveBeenCalledWith(path.join(DESKTOP_DIR, "offline.html"));
  });

  it("ignores an aborted load, which is what a superseding navigation reports", async () => {
    const win = await startShell();

    win.webContentsEvents.emit("did-fail-load", {}, -3, "ERR_ABORTED", APP_ORIGIN, true);

    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it("does not replace the running application when only an embedded frame fails", async () => {
    const win = await startShell();

    win.webContentsEvents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://maps.example.com/embed",
      false
    );

    expect(win.loadFile).not.toHaveBeenCalled();
  });
});

describe("desktop shell popups", () => {
  it.each([
    [`${APP_ORIGIN}/vouchers/print/12`, "allow"],
    [`${APP_ORIGIN}/`, "allow"],
  ])("allows a same-origin popup: %s", async (url, action) => {
    const win = await startShell();

    expect(win.windowOpenHandler({ url })).toEqual({ action });
    expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.hmdinternationalgroup.com.example.net/login",
    "https://hmdinternationalgroup.com.evil.test/",
    "https://www.hmdinternationalgroup.com@evil.test/",
    "http://www.hmdinternationalgroup.com/",
    "https://www.hmdinternationalgroup.com:8443/",
    "https://example.com/",
  ])("hands a different web origin to the system browser and denies the popup: %s", async (url) => {
    const win = await startShell();

    expect(win.windowOpenHandler({ url })).toEqual({ action: "deny" });
    expect(stub.electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(stub.electron.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
    "ms-msdt:/id PCWDiagnostic",
    "smb://attacker.test/share",
    "data:text/html,<script>alert(1)</script>",
  ])("denies a non-web scheme without passing it to the operating system: %s", async (url) => {
    const win = await startShell();

    expect(win.windowOpenHandler({ url })).toEqual({ action: "deny" });
    expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each(["", "not a url", "//missing-scheme"])("denies an unparseable popup target: %j", async (url) => {
    const win = await startShell();

    expect(win.windowOpenHandler({ url })).toEqual({ action: "deny" });
    expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("desktop shell in-window navigation", () => {
  function navigate(url: string) {
    const contents = emitter();
    stub.appEvents.emit("web-contents-created", {}, contents);
    const event = { preventDefault: vi.fn() };
    contents.emit("will-navigate", event, url);
    return event;
  }

  it.each([`${APP_ORIGIN}/factory/dispatch`, "https://hmdinternationalgroup.com/login"])(
    "lets the window navigate within the application hosts: %s",
    async (url) => {
      await startShell();

      const event = navigate(url);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
    }
  );

  it.each([
    "https://www.hmdinternationalgroup.com.example.net/login",
    "https://accounts.example.com/oauth",
    "http://example.com/",
  ])("blocks navigation to another host and opens it in the system browser: %s", async (url) => {
    await startShell();

    const event = navigate(url);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(stub.electron.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each(["file:///etc/passwd", "ms-msdt:/id PCWDiagnostic", "javascript:alert(1)"])(
    "blocks navigation to a non-web scheme without passing it to the operating system: %s",
    async (url) => {
      await startShell();

      const event = navigate(url);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
    }
  );

  it("blocks a malformed navigation target instead of throwing in the main process", async () => {
    await startShell();

    let event: { preventDefault: ReturnType<typeof vi.fn> } | undefined;
    expect(() => {
      event = navigate("not a url");
    }).not.toThrow();

    expect(event?.preventDefault).toHaveBeenCalledTimes(1);
    expect(stub.electron.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("desktop shell lifecycle", () => {
  it("quits when the last window closes", async () => {
    await startShell();

    stub.appEvents.emit("window-all-closed");

    expect(stub.electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it("recreates the window on activate only when none is open", async () => {
    await startShell();

    stub.appEvents.emit("activate");
    expect(stub.windows).toHaveLength(1);

    stub.windows.length = 0;
    stub.appEvents.emit("activate");
    expect(stub.windows).toHaveLength(1);
    expect(stub.windows[0].loadURL).toHaveBeenCalledWith(APP_ORIGIN);
  });

  it("survives menu actions after the window has been closed", async () => {
    const win = await startShell();
    win.events.emit("closed");

    for (const [menuLabel, itemLabel] of [
      ["File", "Reload"],
      ["File", "Force Reload"],
      ["View", "Zoom In"],
      ["View", "Zoom Out"],
      ["View", "Reset Zoom"],
      ["View", "Toggle Fullscreen"],
    ]) {
      expect(() => menuItem(menuLabel, itemLabel).click(), `${menuLabel} > ${itemLabel}`).not.toThrow();
    }
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.setZoomFactor).not.toHaveBeenCalled();
  });
});

describe("desktop shell menu", () => {
  it("installs the File, View and Help menus", async () => {
    await startShell();

    expect(stub.menu.template.map((entry: any) => entry.label)).toEqual(["File", "View", "Help"]);
    expect(stub.electron.Menu.setApplicationMenu).toHaveBeenCalledWith({ built: stub.menu.template });
  });

  it("reloads, force-reloads and exits from the File menu", async () => {
    const win = await startShell();

    menuItem("File", "Reload").click();
    menuItem("File", "Force Reload").click();
    menuItem("File", "Exit").click();

    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(stub.electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it("zooms in steps of 10% and never past 300%", async () => {
    await startShell();
    const zoomIn = menuItem("View", "Zoom In");

    zoomIn.click();
    expect(stub.zoom()).toBeCloseTo(1.1, 5);

    for (let i = 0; i < 40; i += 1) zoomIn.click();
    expect(stub.zoom()).toBe(3);
  });

  it("zooms out in steps of 10% and never below 50%", async () => {
    await startShell();
    const zoomOut = menuItem("View", "Zoom Out");

    zoomOut.click();
    expect(stub.zoom()).toBeCloseTo(0.9, 5);

    for (let i = 0; i < 40; i += 1) zoomOut.click();
    expect(stub.zoom()).toBe(0.5);
  });

  it("resets zoom to 100%", async () => {
    await startShell();

    menuItem("View", "Zoom In").click();
    menuItem("View", "Reset Zoom").click();

    expect(stub.zoom()).toBe(1);
  });

  it("toggles fullscreen on and off", async () => {
    const win = await startShell();
    const toggle = menuItem("View", "Toggle Fullscreen");

    toggle.click();
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true);
    toggle.click();
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false);
  });

  it("shows the running version in About and opens the site from Help", async () => {
    const win = await startShell();

    menuItem("Help", "About ERP Warehouse").click();
    menuItem("Help", "Open in Browser").click();

    const [parent, options] = stub.electron.dialog.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(options.detail).toContain("Version: 9.9.9");
    expect(options.detail).toContain(APP_ORIGIN);
    expect(stub.electron.shell.openExternal).toHaveBeenCalledWith(APP_ORIGIN);
  });
});

describe("desktop preload bridge", () => {
  it("exposes only the platform and version, never an IPC or Node handle", () => {
    loadShellFile(PRELOAD_PATH);

    const { exposeInMainWorld } = stub.electron.contextBridge;
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [name, api] = exposeInMainWorld.mock.calls[0];
    expect(name).toBe("electronAPI");
    expect(Object.keys(api).sort()).toEqual(["platform", "version"]);
    expect(api.platform).toBe(process.platform);
    expect(typeof api.version).toBe("string");
    for (const value of Object.values(api)) expect(typeof value).not.toBe("function");
  });
});
