#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, rm, stat } from "node:fs/promises";

const scriptPath = fileURLToPath(import.meta.url);

if (process.env.PHASE10_VERIFY_CHILD !== "1") {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./server/exportBufferBridge.mjs",
      "--import",
      "./server/scheduledAttachmentBridge.mjs",
      scriptPath,
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        PHASE10_VERIFY_CHILD: "1",
        SCHEDULED_ATTACHMENT_FORCE: "1",
        SCHEDULED_ATTACHMENT_MIN_BYTES: "1",
        SCHEDULED_ATTACHMENT_CLEANUP_DELAY_MS: "60000",
        SCHEDULED_ATTACHMENT_ORPHAN_CLEANUP_DELAY_MS: "60000",
      },
    }
  );
  process.exit(result.status ?? 1);
}

const MARKER_KEY = Symbol.for("erp.export-buffer-bridge.marker");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function markerPayload(value) {
  return value?.[MARKER_KEY];
}

const pathsToRemove = new Set();

try {
  const zipPrefix = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const sourceBytes = Buffer.concat([zipPrefix, Buffer.alloc(256 * 1024, 0x5a)]);
  const sourcePayload = markerPayload(sourceBytes);

  assert(Buffer.isBuffer(sourceBytes), "Managed ZIP result must remain Buffer-compatible");
  assert(sourcePayload?.kind === "file", "ZIP concat should become a file-backed marker");
  assert(sourcePayload.managedAttachment === true, "ZIP marker should be managed");
  assert(sourceBytes.length === 0, "ZIP marker must preserve native Buffer bounds");
  assert(sourcePayload.length === 256 * 1024 + 4, "ZIP payload must preserve the real byte length");
  pathsToRemove.add(sourcePayload.path);

  const sourceStat = await stat(sourcePayload.path);
  assert(sourceStat.size === sourcePayload.length, "Managed ZIP file size does not match payload length");
  const sourceOnDisk = await readFile(sourcePayload.path);
  assert(sourceOnDisk.subarray(0, 4).equals(zipPrefix), "Managed ZIP file lost its signature");

  const formDataNamespace = await import("form-data");
  const FormData = formDataNamespace.default || formDataNamespace;

  let activeRequests = 0;
  let maxActiveRequests = 0;
  const receivedBodies = [];
  const server = createServer((req, res) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks));
      setTimeout(() => {
        activeRequests -= 1;
        res.statusCode = 200;
        res.end("ok");
      }, 50);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/upload`;
    const createUpload = () => {
      const form = new FormData();
      form.append("chatId", "phase10-test@g.us");
      form.append("file", sourceBytes, { filename: "test.zip", contentType: "application/zip" });
      const body = form.getBuffer();
      assert(markerPayload(body)?.kind === "deferred-form", "WhatsApp multipart body should be deferred");
      return fetch(url, { method: "POST", headers: form.getHeaders(), body });
    };

    const [first, second] = await Promise.all([createUpload(), createUpload()]);
    assert(first.ok && second.ok, "Deferred multipart uploads did not complete");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert(maxActiveRequests === 1, `Expected serialized uploads, observed ${maxActiveRequests} concurrent requests`);
  assert(receivedBodies.length === 2, "Expected two multipart request bodies");
  for (const body of receivedBodies) {
    assert(body.includes(zipPrefix), "Deferred multipart request did not include the managed attachment bytes");
  }

  const excelNamespace = await import("exceljs");
  const ExcelJS = excelNamespace.default || excelNamespace;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Phase10");
  sheet.addRow(["scheduled", "attachment", "verification"]);
  const workbookResult = await workbook.xlsx.writeBuffer();
  const workbookPayload = markerPayload(workbookResult);

  assert(workbookPayload?.kind === "file", "Background workbook should become a file-backed marker");
  assert(workbookResult.length === 0, "Workbook marker must preserve native Buffer bounds");
  assert(workbookPayload.length > 0, "Workbook payload should expose its real length");
  pathsToRemove.add(workbookPayload.path);
  const workbookBytes = await readFile(workbookPayload.path);
  assert(workbookBytes[0] === 0x50 && workbookBytes[1] === 0x4b, "Managed workbook is not a valid XLSX ZIP");

  console.log(
    JSON.stringify(
      {
        success: true,
        zipBytes: sourcePayload.length,
        workbookBytes: workbookPayload.length,
        maxConcurrentMultipartUploads: maxActiveRequests,
        verified: [
          "file-backed ZIP marker",
          "native-safe marker bounds",
          "deferred WhatsApp multipart body",
          "serialized WhatsApp uploads",
          "file-backed background workbook",
        ],
      },
      null,
      2
    )
  );
} finally {
  await Promise.all([...pathsToRemove].map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
}
