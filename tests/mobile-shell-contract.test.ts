/**
 * The native (Capacitor) project files must agree with each other.
 *
 * Android, iOS and capacitor.config.ts each state the application id, and the
 * web bundle each one ships is whatever Vite writes to webDir. Nothing compiles
 * these together until a release build on a developer machine, so a mismatch
 * (a renamed package, a stray dev server URL, a broadened permission) ships
 * silently. tests/e2e/mobile-shell/run.mjs covers the bundle's behaviour; this
 * covers the project wiring.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import capacitorConfig from "../capacitor.config";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const manifest = read("android/app/src/main/AndroidManifest.xml");
const gradle = read("android/app/build.gradle");
const pbxproj = read("ios/App/App.xcodeproj/project.pbxproj");
const infoPlist = read("ios/App/App/Info.plist");

function attributeValues(xml: string, tag: string, attribute: string): string[] {
  const values: string[] = [];
  for (const element of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))) {
    const match = element[0].match(new RegExp(`${attribute}="([^"]*)"`));
    if (match) values.push(match[1]);
  }
  return values;
}

function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((match) => match[0]);
}

function plistValue(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`));
  if (!match) return null;
  return match[1] === "string" ? match[2] : match[1];
}

describe("native application identity", () => {
  const appId = capacitorConfig.appId as string;

  it("uses one application id across Capacitor, Android and iOS", () => {
    expect(appId).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    expect(gradle.match(/namespace\s*=\s*"([^"]+)"/)?.[1]).toBe(appId);
    expect(gradle.match(/applicationId\s+"([^"]+)"/)?.[1]).toBe(appId);

    const bundleIds = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((match) => match[1]);
    expect(bundleIds.length).toBeGreaterThan(0);
    expect([...new Set(bundleIds)]).toEqual([appId]);
  });

  it("keeps the Android launcher activity in the package the application id names", () => {
    const activityPath = `android/app/src/main/java/${appId.split(".").join("/")}/MainActivity.java`;
    expect(existsSync(path.join(root, activityPath)), activityPath).toBe(true);
    expect(read(activityPath).match(/^package\s+([\w.]+);/m)?.[1]).toBe(appId);
  });

  it("shows the same product name on both platforms", () => {
    expect(capacitorConfig.appName).toBe("ERP Warehouse");
    expect(plistValue(infoPlist, "CFBundleDisplayName")).toBe(capacitorConfig.appName);
    const strings = read("android/app/src/main/res/values/strings.xml");
    expect(strings.match(/<string name="app_name">([^<]*)<\/string>/)?.[1]).toBe(capacitorConfig.appName);
  });
});

describe("native web payload wiring", () => {
  it("ships the directory the Vite build writes", async () => {
    const { default: viteConfig } = await import("../vite.config");
    const resolved =
      typeof viteConfig === "function" ? await viteConfig({ command: "build", mode: "capacitor" }) : viteConfig;
    const outDir = (resolved as { build?: { outDir?: string } }).build?.outDir;

    expect(outDir).toBeTruthy();
    expect(path.resolve(root, capacitorConfig.webDir as string)).toBe(path.resolve(root, outDir as string));
  });

  it("never commits a live-reload server URL, and serves Android over https", () => {
    expect(capacitorConfig.server?.url).toBeUndefined();
    expect(capacitorConfig.server?.cleartext).not.toBe(true);
    expect(capacitorConfig.server?.androidScheme).toBe("https");
  });

  it("points the native build at the production API over TLS, and the browser build at nothing", () => {
    const env = (file: string) =>
      Object.fromEntries(
        read(file)
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.trim().startsWith("#"))
          .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
      );

    const native = env("client/.env.capacitor");
    expect(new URL(native.VITE_API_BASE_URL).protocol).toBe("https:");
    expect(new URL(native.VITE_API_BASE_URL).pathname).toBe("/");
    expect(native.VITE_API_BASE_URL.endsWith("/")).toBe(false);
    expect(new URL(native.VITE_WS_URL).protocol).toBe("wss:");
    expect(new URL(native.VITE_WS_URL).host).toBe(new URL(native.VITE_API_BASE_URL).host);

    const browser = env("client/.env.production");
    expect(browser.VITE_API_BASE_URL).toBeUndefined();
    expect(browser.VITE_WS_URL).toBeUndefined();
  });
});

describe("Android manifest", () => {
  it("requests only the permissions the app uses", () => {
    expect(attributeValues(manifest, "uses-permission", "android:name").sort()).toEqual([
      "android.permission.INTERNET",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT",
    ]);
  });

  it("exports only the launcher activity", () => {
    const exported = ["activity", "service", "receiver", "provider"].flatMap((tag) =>
      elements(manifest, tag)
        .filter((element) => /android:exported="true"/.test(element))
        .map((element) => `${tag}:${element.match(/android:name="([^"]*)"/)?.[1]}`)
    );
    expect(exported).toEqual(["activity:.MainActivity"]);

    const provider = elements(manifest, "provider");
    expect(provider).toHaveLength(1);
    expect(provider[0]).toMatch(/android:exported="false"/);
  });

  it("does not permit cleartext traffic or a debuggable release", () => {
    const application = elements(manifest, "application")[0];
    expect(application).toBeTruthy();
    expect(application).not.toMatch(/android:usesCleartextTraffic="true"/);
    expect(application).not.toMatch(/android:debuggable="true"/);
    expect(application).not.toMatch(/android:networkSecurityConfig=/);
  });
});

describe("iOS Info.plist", () => {
  it("explains Face ID use, which iOS requires before the biometric prompt", () => {
    expect(plistValue(infoPlist, "NSFaceIDUsageDescription")?.trim().length).toBeGreaterThan(10);
  });

  it("does not relax App Transport Security", () => {
    expect(infoPlist).not.toMatch(/NSAllowsArbitraryLoads/);
    expect(infoPlist).not.toMatch(/NSExceptionAllowsInsecureHTTPLoads/);
  });
});
