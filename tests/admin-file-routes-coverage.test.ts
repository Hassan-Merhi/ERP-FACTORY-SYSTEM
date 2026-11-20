/**
 * File and folder routes over real HTTP in one rolled-back transaction per
 * test: folder create / rename / delete refusals (blank name, non-empty
 * folder, unknown and other-company ids), upload / rename / move / download /
 * preview / delete with their 400 / 404 refusals, and the factory LAN upload
 * size cap and outbox capture. The edge configuration reader is the only stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const edge = vi.hoisted(() => ({ config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown> }));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

afterEach(() => {
  edge.config = { mode: "cloud", primary: false, siteId: null };
});

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`, [
    `${w.tag}OC`,
  ]);
const storedFile = (w: FactoryWorld, companyId = w.companyId, folderId: number | null = null) =>
  w.one(
    `INSERT INTO stored_files (company_id, folder_id, file_name, file_type, file_size, file_data)
     VALUES ($1, $2, 'note.txt', 'text/plain', 5, $3) RETURNING id`,
    [companyId, folderId, Buffer.from("hello").toString("base64")]
  );

describe("folders", () => {
  it("creates, lists, renames and deletes folders with their refusals", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/file-folders").send({ name: "  " })).status).toBe(400);
      const created = await w.agent.post("/api/file-folders").send({ name: " Invoices " });
      expect(created.body.name).toBe("Invoices");
      expect((await w.agent.get("/api/file-folders")).body.map((f: { name: string }) => f.name)).toEqual(["Invoices"]);
      const id = created.body.id;
      expect((await w.agent.patch(`/api/file-folders/${id}`).send({ name: "" })).status).toBe(400);
      expect((await w.agent.patch(`/api/file-folders/${id}`).send({ name: "Bills" })).body.name).toBe("Bills");
      expect((await w.agent.patch("/api/file-folders/2147483000").send({ name: "X" })).status).toBe(404);
      await storedFile(w, w.companyId, id);
      const busy = await w.agent.delete(`/api/file-folders/${id}`);
      expect([busy.status, busy.body.fileCount]).toEqual([409, 1]);
      await w.q(`DELETE FROM stored_files WHERE folder_id = $1`, [id]);
      expect((await w.agent.delete(`/api/file-folders/${id}`)).body).toEqual({ message: "Folder deleted" });
      expect((await w.agent.delete(`/api/file-folders/${id}`)).status).toBe(404);
    }));

  it("does not rename or delete another company's folder", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const folder = await w.one(`INSERT INTO file_folders (company_id, name) VALUES ($1, 'Theirs') RETURNING id`, [
        other,
      ]);
      expect((await w.agent.patch(`/api/file-folders/${folder}`).send({ name: "Mine" })).status).toBe(404);
      expect((await w.agent.delete(`/api/file-folders/${folder}`)).status).toBe(404);
      expect(await w.q(`SELECT name FROM file_folders WHERE id = $1`, [folder])).toEqual([{ name: "Theirs" }]);
    }));
});

describe("files", () => {
  it("uploads, renames, moves, downloads, previews and deletes a file", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/files/upload")).status).toBe(400);
      const folder = await w.one(`INSERT INTO file_folders (company_id, name) VALUES ($1, 'F') RETURNING id`, [
        w.companyId,
      ]);
      const up = await w.agent
        .post("/api/files/upload")
        .field("description", "receipt")
        .field("folderId", String(folder))
        .attach("file", Buffer.from("abc"), { filename: "a.txt", contentType: "text/plain" });
      expect(up.status).toBe(200);
      const plain = await w.agent
        .post("/api/files/upload")
        .attach("file", Buffer.from("xyz"), { filename: "b.txt", contentType: "text/plain" });
      const [row] = await w.q(`SELECT folder_id, description FROM stored_files WHERE id = $1`, [plain.body.id]);
      expect(row).toEqual({ folder_id: null, description: null });
      expect((await w.agent.get("/api/files")).body).toHaveLength(2);

      const id = up.body.id;
      const dl = await w.agent.get(`/api/files/${id}/download`).buffer(true);
      expect(dl.headers["content-disposition"]).toBe('attachment; filename="a.txt"');
      expect((await w.agent.patch(`/api/files/${id}`).send({})).status).toBe(400);
      await w.agent.patch(`/api/files/${id}`).send({ displayName: "Renamed.txt", folderId: null });
      const pv = await w.agent.get(`/api/files/${id}/preview`).buffer(true);
      expect(pv.headers["content-disposition"]).toBe('inline; filename="Renamed.txt"');
      await w.agent.patch(`/api/files/${id}`).send({ displayName: "", folderId: String(folder) });
      const [moved] = await w.q(`SELECT display_name, folder_id FROM stored_files WHERE id = $1`, [id]);
      expect(moved).toEqual({ display_name: null, folder_id: folder });
      expect((await w.agent.get(`/api/files/${plain.body.id}/preview`)).headers["content-disposition"]).toBe(
        'inline; filename="b.txt"'
      );
      expect((await w.agent.delete(`/api/files/${id}`)).body).toEqual({ message: "File deleted" });
      for (const res of [
        await w.agent.delete(`/api/files/${id}`),
        await w.agent.get(`/api/files/${id}/download`),
        await w.agent.get(`/api/files/${id}/preview`),
        await w.agent.patch(`/api/files/${id}`).send({ displayName: "x" }),
      ]) {
        expect(res.status).toBe(404);
      }
    }));

  it("never serves, renames or deletes another company's file", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const theirs = await storedFile(w, other);
      expect((await w.agent.get(`/api/files/${theirs}/download`)).status).toBe(404);
      expect((await w.agent.get(`/api/files/${theirs}/preview`)).status).toBe(404);
      expect((await w.agent.patch(`/api/files/${theirs}`).send({ displayName: "x" })).status).toBe(404);
      expect((await w.agent.delete(`/api/files/${theirs}`)).status).toBe(404);
      expect(await w.q(`SELECT display_name FROM stored_files WHERE id = $1`, [theirs])).toEqual([
        { display_name: null },
      ]);
    }));
});

describe("handlers without a selected company", () => {
  it("answers 400 on every route when the session has no company", async () => {
    type Handler = (req: unknown, res: unknown) => unknown;
    const routes: [string, string, Handler][] = [];
    const recorder = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (path: string, ...handlers: Handler[]) =>
            routes.push([method, path, handlers[handlers.length - 1]]),
      }
    );
    const { registerFileRoutes } = await import("../server/routes/admin/import-export/files");
    registerFileRoutes(recorder as never);
    expect(routes.length).toBe(10);
    for (const [method, path, handler] of routes) {
      let status = 0;
      let body: unknown;
      const res = {
        status: (code: number) => ((status = code), res),
        json: (value: unknown) => ((body = value), res),
      };
      await handler({ session: { userId: "u" }, params: { id: "1" }, body: {}, headers: {} }, res);
      expect([method, path, status, body]).toEqual([method, path, 400, { message: "No company selected" }]);
    }
  });
});

describe("factory LAN capture", () => {
  it("refuses an oversized LAN upload and captures a normal one in the outbox", () =>
    withFactoryWorld(async (w) => {
      edge.config = { mode: "lan", primary: true, siteId: "00000000-0000-4000-8000-000000000001" };
      const big = await w.agent
        .post("/api/files/upload")
        .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), {
          filename: "big.bin",
          contentType: "application/octet-stream",
        });
      expect([big.status, big.body.code]).toEqual([413, "EDGE_ATTACHMENT_TOO_LARGE"]);
      const ok = await w.agent
        .post("/api/files/upload")
        .field("description", "lan note")
        .attach("file", Buffer.from("lan"), { filename: "lan.txt", contentType: "text/plain" });
      expect(ok.status).toBe(200);
      const rename = await w.agent.patch(`/api/files/${ok.body.id}`).send({ displayName: "LAN renamed" });
      expect(rename.status).toBe(200);
      const folder = await w.one(`INSERT INTO file_folders (company_id, name) VALUES ($1, 'LAN') RETURNING id`, [
        w.companyId,
      ]);
      const filed = await w.agent
        .post("/api/files/upload")
        .field("folderId", String(folder))
        .attach("file", Buffer.from("in folder"), { filename: "f.txt", contentType: "text/plain" });
      expect(filed.status).toBe(200);
    }));
});
