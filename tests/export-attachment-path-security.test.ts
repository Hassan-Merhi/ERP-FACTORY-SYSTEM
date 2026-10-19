import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertExportAttachmentAvailable,
  readExportAttachmentBuffer,
  toNodemailerAttachment,
} from "../server/helpers/exportAttachmentSource";

describe("managed export attachment path security", () => {
  const originalBridgeDir = process.env.EXPORT_BRIDGE_TEMP_DIR;
  let bridgeDir: string;

  beforeEach(() => {
    bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-security-bridge-"));
    process.env.EXPORT_BRIDGE_TEMP_DIR = bridgeDir;
  });

  afterEach(() => {
    if (originalBridgeDir === undefined) delete process.env.EXPORT_BRIDGE_TEMP_DIR;
    else process.env.EXPORT_BRIDGE_TEMP_DIR = originalBridgeDir;
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  });

  function serverBridgeFilename(extension = "xlsx"): string {
    return `${Date.now()}-${randomUUID()}.${extension}`;
  }

  it("accepts a server-created bridge file and checks its size", async () => {
    const filePath = path.join(bridgeDir, serverBridgeFilename());
    fs.writeFileSync(filePath, "report");
    const source = { filePath, sizeBytes: 6 };
    expect(toNodemailerAttachment(source, "report.xlsx", "application/vnd.ms-excel").path).toBe(filePath);
    await expect(assertExportAttachmentAvailable(source)).resolves.toBeUndefined();
    await expect(readExportAttachmentBuffer(source)).resolves.toEqual(Buffer.from("report"));
  });

  it("rejects a different filename in an otherwise trusted temp directory", () => {
    const filePath = path.join(bridgeDir, "credentials.json");
    fs.writeFileSync(filePath, "private");
    expect(() => toNodemailerAttachment({ filePath, sizeBytes: 7 }, "x", "text/plain")).toThrow(/EXPORT_PATH_ERR/);
  });

  it("rejects a path from a nested directory even with a matching filename", () => {
    const nested = path.join(bridgeDir, "nested");
    fs.mkdirSync(nested);
    const filePath = path.join(nested, serverBridgeFilename());
    fs.writeFileSync(filePath, "report");
    expect(() => toNodemailerAttachment({ filePath, sizeBytes: 6 }, "x", "text/plain")).toThrow(/EXPORT_PATH_ERR/);
  });

  it.skipIf(process.platform === "win32")("rejects symbolic links to other files", () => {
    const sensitive = path.join(bridgeDir, "private.txt");
    const candidate = path.join(bridgeDir, serverBridgeFilename());
    fs.writeFileSync(sensitive, "do not attach");
    fs.symlinkSync(sensitive, candidate);
    expect(() => toNodemailerAttachment({ filePath: candidate, sizeBytes: 13 }, "x", "text/plain")).toThrow(
      /EXPORT_PATH_ERR/
    );
  });

  it("accepts a genuine scheduled archive directly under the OS temp root", () => {
    const filePath = path.join(os.tmpdir(), `erp-export-security-${randomUUID()}-${Date.now()}.zip`);
    try {
      fs.writeFileSync(filePath, "archive", { flag: "wx" });
      expect(toNodemailerAttachment({ filePath, sizeBytes: 7 }, "archive.zip", "application/zip").path).toBe(
        path.join(fs.realpathSync.native(os.tmpdir()), path.basename(filePath))
      );
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("rejects an arbitrary existing file at the OS temp root", () => {
    const filePath = path.join(os.tmpdir(), `not-an-erp-export-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(filePath, "secret");
      expect(() => toNodemailerAttachment({ filePath, sizeBytes: 6 }, "x", "text/plain")).toThrow(/EXPORT_PATH_ERR/);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
