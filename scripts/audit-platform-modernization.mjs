#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModuleFamily } from "./lib/readModuleFamily.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readModuleFamily(path.join(root, file));
const readJson = (file) => JSON.parse(read(file));
const major = (spec) => Number(String(spec ?? "").match(/\d+/)?.[0] ?? NaN);
const capture = (text, pattern) => text.match(pattern)?.[1] ?? null;

export function auditPlatformModernization() {
  const failures = [];
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  const pkg = readJson("package.json");
  const canonicalNode = read(".node-version").trim();
  const canonicalNodeMajor = Number(canonicalNode.split(".")[0]);
  const deps = pkg.dependencies ?? {};
  const dev = pkg.devDependencies ?? {};

  check(
    "Node runtime types",
    major(dev["@types/node"]) === canonicalNodeMajor,
    `@types/node ${dev["@types/node"] ?? "missing"} must stay on canonical Node major ${canonicalNodeMajor}`
  );
  check(
    "bcryptjs bundled types",
    !Object.hasOwn(dev, "@types/bcryptjs"),
    "bcryptjs ships its own declarations; the deprecated stub @types/bcryptjs must not return"
  );

  const pdfMajor = major(deps["pdf-parse"]);
  check(
    "pdf-parse bundled types",
    !(pdfMajor >= 2 && Object.hasOwn(dev, "@types/pdf-parse")),
    "pdf-parse v2+ ships its own declarations; legacy @types/pdf-parse must not return"
  );

  const route = read("server/routes/chatbotPoImportRoutes.ts");
  check(
    "pdf-parse v2 API",
    route.includes('const { PDFParse } = await import("pdf-parse")') &&
      route.includes("new PDFParse({ data: new Uint8Array(req.file.buffer) })") &&
      route.includes("await parser.destroy()") &&
      !route.includes("pdfParseModule.default ?? pdfParseModule"),
    "PO PDF import must use PDFParse#getText and destroy the parser"
  );

  const tailwindMajor = major(deps.tailwindcss);
  check(
    "Tailwind/Vite pairing",
    tailwindMajor >= 4 || !Object.hasOwn(dev, "@tailwindcss/vite"),
    "Tailwind 3 must not carry the Tailwind 4 Vite plugin in the production root"
  );

  const capacitorFamily = ["@capacitor/android", "@capacitor/cli", "@capacitor/core", "@capacitor/ios"];
  const capacitorSpecs = capacitorFamily.map((name) => deps[name]);
  const normalizedCapacitorSpecs = capacitorSpecs.map((spec) => String(spec ?? "").replace(/^[~^]/, ""));
  check(
    "Capacitor JS family",
    normalizedCapacitorSpecs.every((spec) => spec === normalizedCapacitorSpecs[0]) && major(capacitorSpecs[0]) === 8,
    `${capacitorFamily.map((name, index) => `${name}=${capacitorSpecs[index]}`).join(", ")} must stay aligned on Capacitor 8`
  );

  const vars = read("android/variables.gradle");
  const androidExpected = {
    minSdkVersion: "24",
    compileSdkVersion: "36",
    targetSdkVersion: "36",
    androidxActivityVersion: "1.11.0",
    androidxAppCompatVersion: "1.7.1",
    androidxCoordinatorLayoutVersion: "1.3.0",
    androidxCoreVersion: "1.17.0",
    androidxFragmentVersion: "1.8.9",
    coreSplashScreenVersion: "1.2.0",
    androidxWebkitVersion: "1.14.0",
    androidxJunitVersion: "1.3.0",
    androidxEspressoCoreVersion: "3.7.0",
    cordovaAndroidVersion: "14.0.1",
  };
  const androidMismatches = Object.entries(androidExpected).filter(([key, expected]) => {
    const actual = capture(vars, new RegExp(`${key}\\s*=\\s*['\"]?([^'\"\\s]+)`));
    return actual !== expected;
  });
  check(
    "Capacitor Android variables",
    androidMismatches.length === 0,
    androidMismatches.length
      ? androidMismatches.map(([key, expected]) => `${key} must be ${expected}`).join("; ")
      : "Capacitor 8 Android SDK and AndroidX baseline is aligned"
  );

  const androidBuild = read("android/build.gradle");
  check(
    "Android Gradle Plugin",
    androidBuild.includes("com.android.tools.build:gradle:8.13.0"),
    "Capacitor 8 baseline requires AGP 8.13.0"
  );
  check(
    "Google services plugin",
    androidBuild.includes("com.google.gms:google-services:4.4.4"),
    "Android project must use the Capacitor 8 template google-services baseline 4.4.4"
  );

  const wrapper = read("android/gradle/wrapper/gradle-wrapper.properties");
  check(
    "Gradle wrapper",
    wrapper.includes("gradle-8.14.3-all.zip"),
    "Capacitor 8 baseline requires Gradle 8.14.3"
  );

  const manifest = read("android/app/src/main/AndroidManifest.xml");
  check(
    "Android density config change",
    /android:configChanges="[^"]*\bdensity\b[^"]*"/.test(manifest),
    "Capacitor 8 activity configChanges must include density"
  );

  const podfile = read("ios/App/Podfile");
  const iosTarget = Number(capture(podfile, /platform\s+:ios,\s*['\"]([0-9.]+)['\"]/));
  check(
    "iOS deployment target",
    Number.isFinite(iosTarget) && iosTarget >= 15,
    `Capacitor 8 requires iOS 15+; found ${Number.isFinite(iosTarget) ? iosTarget : "none"}`
  );

  const desktop = readJson("desktop/package.json");
  check(
    "Desktop runtime present",
    major(desktop.devDependencies?.electron) >= 43 && major(desktop.devDependencies?.["electron-builder"]) === 26,
    `desktop electron=${desktop.devDependencies?.electron ?? "missing"}, electron-builder=${desktop.devDependencies?.["electron-builder"] ?? "missing"}`
  );

  return { failures, checks, summary: { checked: checks.length, failing: failures.length } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditPlatformModernization();
  if (report.failures.length) {
    console.error(report.failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Platform modernization coherent: ${report.summary.checked} checks passed.`);
  }
}
