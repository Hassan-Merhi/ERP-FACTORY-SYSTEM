/**
 * The container document download handler: which folders it serves, the
 * session-derived actor, the stored document lookup, the safe download
 * headers, disk-or-database bytes, and how denials map to 404/403.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContainerDocumentDownloadHandler } from "../server/services/security/protectedAssetDownloadAdapter";

let docs: Array<Record<string, unknown>>;
let selects: number;
const db = {
  select: () => {
    selects += 1;
    const chain = { from: () => chain, where: () => chain, limit: async () => docs };
    return chain;
  },
} as never;

const doc = (over: Record<string, unknown> = {}) => ({
  id: 1,
  companyId: 10,
  uploadedBy: "owner",
  storageKey: "container-docs/bill.pdf",
  fileName: "Bill of lading.pdf",
  mimeType: "application/pdf",
  fileData: Buffer.from("PDF-BYTES").toString("base64"),
  ...over,
});

function call(params: Record<string, string | undefined>, session: Record<string, unknown>) {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    sentFile: undefined as string | undefined,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    send(value: unknown) {
      this.body = value;
      return this;
    },
    sendFile(file: string) {
      this.sentFile = file;
      return this;
    },
  };
  const next = vi.fn();
  const handler = createContainerDocumentDownloadHandler(db);
  return handler({ params, session } as never, res as never, next).then(() => ({ res, next }));
}

const session = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  currentRole: "Manager",
  currentCompanyId: 10,
  ...over,
});

beforeEach(() => {
  docs = [doc()];
  selects = 0;
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("container document download handler", () => {
  it("delegates other upload folders to the next route", async () => {
    for (const folder of ["invoices", undefined]) {
      const { res, next } = await call({ folder, filename: "x.pdf" }, session());
      expect(next).toHaveBeenCalledWith();
      expect(res.body).toBeUndefined();
    }
    expect(selects).toBe(0);
  });

  it("serves stored bytes with safe attachment headers", async () => {
    const { res, next } = await call(
      { folder: "container-docs", filename: "bill.pdf" },
      session({ securityPermissions: ["x", 3] })
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.headers).toEqual({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Bill of lading.pdf"; filename*=UTF-8''Bill%20of%20lading.pdf`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    expect(Buffer.isBuffer(res.body) && (res.body as Buffer).toString()).toBe("PDF-BYTES");
  });

  it("prefers the file on disk and defaults the content type", async () => {
    docs = [doc({ mimeType: null })];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { res } = await call({ folder: "container-docs", filename: "bill.pdf" }, session());
    expect(res.sentFile).toBe(path.join(process.cwd(), "uploads", "container-docs/bill.pdf"));
    expect(res.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("answers 404 when neither disk nor database has the bytes", async () => {
    docs = [doc({ fileData: null })];
    const { res } = await call({ folder: "container-docs", filename: "bill.pdf" }, session());
    expect([res.statusCode, res.body]).toEqual([404, { message: "Not found" }]);
  });

  it("hides missing documents and other companies' documents as 404", async () => {
    docs = [];
    expect((await call({ folder: "container-docs", filename: "bill.pdf" }, session())).res.statusCode).toBe(404);
    docs = [doc({ companyId: 11 })];
    expect((await call({ folder: "container-docs", filename: "bill.pdf" }, session())).res.body).toEqual({
      message: "Not found",
    });
    // A traversal key never reaches the disk: the asset policy rejects it.
    docs = [doc({ storageKey: "container-docs/../secret.pdf" })];
    expect((await call({ folder: "container-docs", filename: "../secret.pdf" }, session())).res.statusCode).toBe(404);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("refuses sessions without a user, role or matching factory company", async () => {
    for (const s of [
      session({ userId: undefined }),
      session({ currentRole: undefined }),
      session({ currentCompanyId: undefined }),
      session({ factoryCompanyId: 99 }),
    ]) {
      const { res } = await call({ folder: "container-docs", filename: "bill.pdf" }, s);
      expect([res.statusCode, res.body]).toEqual([404, { message: "Not found" }]);
    }
    const sameFactory = await call(
      { folder: "container-docs", filename: "bill.pdf" },
      session({ factoryCompanyId: 10 })
    );
    expect(sameFactory.res.statusCode).toBe(200);
  });

  it("passes unexpected errors on", async () => {
    const failing = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    const next = vi.fn();
    await createContainerDocumentDownloadHandler(failing)(
      { params: { folder: "container-docs", filename: "bill.pdf" }, session: session() } as never,
      res as never,
      next
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "db down" }));
  });
});
