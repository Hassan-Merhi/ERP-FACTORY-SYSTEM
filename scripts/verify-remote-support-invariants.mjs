#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const failures = [];

function read(path) {
  if (!existsSync(path)) {
    failures.push(`${path}: missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireMarkers(path, markers) {
  const source = read(path);
  for (const marker of markers) {
    if (!source.includes(marker)) failures.push(`${path}: missing ${JSON.stringify(marker)}`);
  }
  return source;
}

function forbidMarkers(path, markers) {
  const source = read(path);
  for (const marker of markers) {
    if (source.includes(marker)) failures.push(`${path}: forbidden ${JSON.stringify(marker)}`);
  }
}

requireMarkers("server/routes/screenFeedRoutes.ts", [
  'app.post("/api/screen-feed"',
  'app.get("/api/screen-feed/:userId"',
  "screenFeedStoreKey",
  "authorizeFrameAccess",
  "beginScreenWatch",
]);

requireMarkers("client/src/lib/screen-feed-binary-transport.ts", [
  "trySendScreenFeedBinaryFrame",
  "sendScreenFeedHttpFallback",
  'fetch("/api/screen-feed"',
  '"If-None-Match"',
  "response.status === 304",
  'transport: "http-fallback"',
  "scheduleViewerPollingFallback(0)",
]);

requireMarkers("client/src/hooks/remote-control-surface-coverage.ts", [
  "setAttributeIfChanged",
  "requestAnimationFrame",
  "record.addedNodes",
  "minimalMutationRoots",
  "annotateRemoteControlSurface(changedRoot)",
  // The observer was pinned as a single-line childList/subtree call. It now
  // also watches the attributes the annotation decisions read, so a control
  // that becomes usable after mount (a portal field enabled once its data
  // loads) is discovered and one that stops qualifying loses its annotation.
  // The parts that carry the contract are pinned individually instead, which
  // pins strictly more of the call than the old single literal did.
  "childList: true,",
  "subtree: true,",
  "attributeFilter: ANNOTATION_INPUT_ATTRIBUTES,",
]);
forbidMarkers("client/src/hooks/remote-control-surface-coverage.ts", [
  "new MutationObserver(() => annotateRemoteControlSurface(root))",
]);

requireMarkers(".github/workflows/remote-support-rollout-e2e.yml", [
  "pull_request:",
  "schedule:",
  "workflow_dispatch:",
  "verify-remote-support-phase17-invariants.mjs",
  'REMOTE_SUPPORT_GATE_MAX_FRAME_INTERVAL_P95_MS: "1500"',
  "REMOTE_SUPPORT_STAGING_BASE_URL",
]);

for (const path of [
  "docs/archive/remote-support-phase-13.md",
  "docs/archive/remote-support-phase-14.md",
  "docs/archive/remote-support-phase-15.md",
  "docs/archive/remote-support-phase-16.md",
  "docs/remote-support-phase-17-transport-resilience.md",
]) {
  if (!existsSync(path)) failures.push(`${path}: missing`);
}

if (failures.length > 0) {
  console.error("[remote-support-phase17] FAIL");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log("[remote-support-phase17] PASS: transport recovery, target-side annotation, gate topology, and docs are pinned.");
}
