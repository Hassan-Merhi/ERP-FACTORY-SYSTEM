#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(path.join(tmpdir(), "erp-phase9-verify-"));
process.env.EXPORT_BRIDGE_TEMP_DIR = tempRoot;
process.env.EXPORT_CHUNK_BRIDGE_MIN_BYTES = "1";
process.env.HEAVY_EXPORT_MAX_CONCURRENT = "1";

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// Bridges are preloaded through the ordered manifest (server/startupPreload.mjs).
assert.match(packageJson.scripts.dev, /--import \.\/server\/startupPreload\.mjs/);
assert.match(packageJson.scripts.start, /--import \.\/server\/startupPreload\.mjs/);
assert.match(
  await readFile(path.join(root, "server/startupPreload.mjs"), "utf8"),
  /await import\("\.\/exportBufferBridge\.mjs"\);/
);
assert.match(packageJson.scripts.start, /--import \.\/server\/runtimeMemoryGuard\.mjs/);

const bridgeSource = await readFile(path.join(root, "server", "exportBufferBridge.mjs"), "utf8");
assert.match(bridgeSource, /exportAwareWriteBuffer/);
assert.match(bridgeSource, /bridgedBufferConcat/);
assert.match(bridgeSource, /applicationOwnsConcatCall/);
assert.match(bridgeSource, /erp\.heavy-export-coordinator\.state/);

const coordinatorSource = await readFile(path.join(root, "server", "services", "heavyExportCoordinator.ts"), "utf8");
assert.match(coordinatorSource, /erp\.heavy-export-coordinator\.state/);
assert.match(coordinatorSource, /erp\.heavy-export-coordinator\.context/);
assert.match(coordinatorSource, /isHeavyExportSlotActive/);

await import(`../server/exportBufferBridge.mjs?verify=${Date.now()}`);
const excelNamespace = await import("exceljs");
const ExcelJS = excelNamespace.default || excelNamespace;

const server = http.createServer(async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Smoke");
    sheet.addRow(["phase", "status"]);
    for (let index = 0; index < 2000; index += 1) sheet.addRow([9, `row-${index}`]);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="phase9-smoke.xlsx"');
    const workbookResult = Buffer.from(await workbook.xlsx.writeBuffer());
    // Routes commonly derive Content-Length from the Buffer-compatible marker.
    // Native-safe markers have zero backing bytes, so the response bridge must
    // replace that placeholder with the deferred payload's real length.
    res.setHeader("Content-Length", String(workbookResult.byteLength));
    res.end(workbookResult);
  } catch (error) {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.stack || error.message : String(error));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
assert(address && typeof address === "object");

const response = await new Promise((resolve, reject) => {
  const request = http.get({ hostname: "127.0.0.1", port: address.port, path: "/api/export/phase9-smoke" }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  request.once("error", reject);
});

await new Promise((resolve) => server.close(resolve));

assert.equal(response.statusCode, 200);
assert.equal(response.body.subarray(0, 2).toString("ascii"), "PK");
assert.equal(Number(response.headers["content-length"]), response.body.length);
assert(response.body.length > 10_000);

const attachmentWorkbook = new ExcelJS.Workbook();
attachmentWorkbook.addWorksheet("Attachment").addRow(["buffered", "attachment"]);
const attachmentBytes = await attachmentWorkbook.xlsx.writeBuffer();
assert(Buffer.isBuffer(attachmentBytes));
assert(attachmentBytes.length > 0);

const cleanupDeadline = Date.now() + 2000;
let remainingFiles = await readdir(tempRoot);
while (remainingFiles.length > 0 && Date.now() < cleanupDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  remainingFiles = await readdir(tempRoot);
}
assert.deepEqual(remainingFiles, []);

await rm(tempRoot, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      streamedWorkbookBytes: response.body.length,
      bufferedAttachmentBytes: attachmentBytes.length,
      tempFilesRemaining: remainingFiles.length,
    },
    null,
    2
  )
);
