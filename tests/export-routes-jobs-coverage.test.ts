/**
 * The daily-export HTTP routes (recipients, settings, async export jobs and
 * archive download) through the real app. The archive builders, the mail
 * sender, the company list and the run tracker are mocked at their module
 * boundary; recipients and settings use PostgreSQL inside one rolled-back
 * transaction per test.
 */
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  companies: vi.fn(),
  archive: vi.fn(),
  stream: vi.fn(),
  artifact: vi.fn(),
  send: vi.fn(),
  createRun: vi.fn(async () => 77),
  updateRun: vi.fn(async () => undefined),
  finishRun: vi.fn(async () => undefined),
}));

vi.mock("../server/services/export-data", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAllCompanies: h.companies,
}));
vi.mock("../server/helpers/temporaryExportArchive", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTemporaryExportArchive: h.archive,
  streamTemporaryExportArchive: h.stream,
}));
vi.mock("../server/helpers/scheduledExportArtifact", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createScheduledExportArtifact: h.artifact,
}));
vi.mock("../server/services/emailService", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendExportEmail: h.send,
}));
vi.mock("../server/helpers/exportRunTracker", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createExportRun: h.createRun,
  updateExportRun: h.updateRun,
  finishExportRun: h.finishRun,
}));

import { withFactoryWorld as factoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

/** The export center is Developer-only: run as the world's user promoted to Developer. */
function withFactoryWorld(work: (w: FactoryWorld) => Promise<void>) {
  return factoryWorld(async (w) => {
    await w.setRole("Developer");
    await work(w);
  });
}

const missingZip = () => path.join(os.tmpdir(), `erp-export-never-created-${process.pid}-${Date.now()}.zip`);

async function finishedJob(w: FactoryWorld, body: Record<string, unknown>) {
  const start = await w.agent.post("/api/export/start").send(body);
  expect(start.status).toBe(200);
  let job = { status: "running" } as Record<string, any>;
  await vi.waitFor(
    async () => {
      job = (await w.agent.get(`/api/export/job/${start.body.jobId}`)).body;
      expect(job.status).not.toBe("running");
    },
    { timeout: 5000, interval: 20 }
  );
  await vi.waitFor(() => expect(h.finishRun).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
  return { jobId: start.body.jobId as string, job };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.companies.mockResolvedValue([{ id: 1, name: "A" }]);
});

describe("export recipients and settings", () => {
  it("refuses every role but Developer before the handler (the all-company export center)", async () => {
    await factoryWorld(async (w) => {
      const admin = await w.agent.get("/api/export/recipients");
      expect([admin.status, admin.body.code]).toEqual([403, "GLOBAL_EXPORT_DEVELOPER_REQUIRED"]);
      const manager = await w.agentFor("Manager");
      expect((await manager.post("/api/export/start").send({ mode: "download" })).status).toBe(403);
      expect(h.createRun).not.toHaveBeenCalled();
    });
  });

  it("adds, lists, rejects duplicates and invalid emails, and deletes recipients", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/export/recipients").send({ email: "nope" })).status).toBe(400);
      const email = `${w.tag.toLowerCase()}@example.com`;
      const added = await w.agent.post("/api/export/recipients").send({ email: `  ${email.toUpperCase()} ` });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ email, active: true });
      const list = await w.agent.get("/api/export/recipients");
      expect(list.body.map((r: { email: string }) => r.email)).toContain(email);
      expect((await w.agent.delete(`/api/export/recipients/${added.body.id}`)).body).toEqual({ success: true });
      expect(await w.q(`SELECT id FROM export_recipients WHERE id = $1`, [added.body.id])).toEqual([]);
      await w.agent.post("/api/export/recipients").send({ email });
      // A failed statement aborts the world's transaction, so each refusal
      // that reaches PostgreSQL is the last request of its world.
      const dup = await w.agent.post("/api/export/recipients").send({ email });
      expect([dup.status, dup.body.message]).toEqual([409, "Email already exists"]);
    });
  });

  it("reports database failures of the recipient and settings handlers as 500", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.delete(`/api/export/recipients/not-a-number`)).status).toBe(500);
    });
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/export/recipients").send({ email: `${"x".repeat(400)}@a.b` })).status).toBe(500);
    });
    await withFactoryWorld(async (w) => {
      await w.q(`ALTER TABLE export_recipients RENAME COLUMN active TO active_renamed`);
      expect((await w.agent.get("/api/export/recipients")).status).toBe(500);
    });
    await withFactoryWorld(async (w) => {
      await w.q(`ALTER TABLE export_settings RENAME COLUMN gmail_user TO gmail_user_renamed`);
      expect((await w.agent.get("/api/export/settings")).status).toBe(500);
    });
  });

  it("returns defaults without a settings row, inserts it, then updates only supplied fields", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`DELETE FROM export_settings`);
      expect((await w.agent.get("/api/export/settings")).body).toEqual({
        gmailUser: "",
        scheduleEnabled: false,
        lastRunAt: null,
        scheduleHour: 18,
        scheduleTimezone: "America/New_York",
      });
      expect((await w.agent.put("/api/export/settings").send({ gmailUser: "a@b.c" })).body).toEqual({ success: true });
      const update = await w.agent
        .put("/api/export/settings")
        .send({ gmailAppPassword: "secret", scheduleEnabled: true, scheduleHour: 7, scheduleTimezone: "UTC" });
      expect(update.status).toBe(200);
      await w.agent.put("/api/export/settings").send({ gmailAppPassword: "", scheduleEnabled: true });
      expect((await w.agent.get("/api/export/settings")).body).toMatchObject({
        gmailUser: "a@b.c",
        scheduleEnabled: true,
        scheduleHour: 7,
        scheduleTimezone: "UTC",
      });
      const [row] = await w.q(`SELECT gmail_app_password FROM export_settings WHERE id = 1`);
      expect(row.gmail_app_password).toBe("secret");
      const bad = await w.agent.put("/api/export/settings").send({ scheduleHour: "not-an-hour" });
      expect(bad.status).toBe(500);
    });
  });
});

describe("export jobs", () => {
  it("validates the mode and dates and reports unknown jobs", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/export/start").send({ mode: "fax" })).status).toBe(400);
      const badDate = await w.agent.post("/api/export/start").send({ mode: "download", fromDate: "2026-02-31" });
      expect(badDate.status).toBe(400);
      expect((await w.agent.get("/api/export/job/none")).status).toBe(404);
      expect((await w.agent.get("/api/export/download/none")).status).toBe(404);
      expect(h.createRun).not.toHaveBeenCalled();
    });
  });

  it("fails the job when there are no companies", async () => {
    await withFactoryWorld(async (w) => {
      h.companies.mockResolvedValue([]);
      const { job } = await finishedJob(w, { mode: "download" });
      expect(job).toMatchObject({ status: "error", error: "No companies found", hasZip: false });
      expect(h.finishRun).toHaveBeenCalledWith(77, { status: "failed", skippedReason: "No companies found." });
    });
  });

  it("builds a download archive, streams it once and releases it", async () => {
    await withFactoryWorld(async (w) => {
      h.archive.mockImplementation(async (_id, _companies, _from, _to, progress) => {
        progress("building");
        return { filePath: missingZip(), names: ["A.xlsx"], skipped: ["B"], bytesWritten: 2048 };
      });
      h.stream.mockImplementation(async (res: { status: (n: number) => { send: (b: string) => void } }) => {
        res.status(200).send("zip-bytes");
      });
      const { jobId, job } = await finishedJob(w, { mode: "download", fromDate: "2026-01-01", toDate: "2026-01-31" });
      expect(job).toMatchObject({ status: "done", hasZip: true, zipSizeBytes: 2048 });
      expect(job.steps.map((s: { message: string }) => s.message)).toContain("Skipped 1 companies: B");
      expect(h.updateRun).toHaveBeenCalledWith(77, expect.objectContaining({ skippedCompanies: "B" }));
      const download = await w.agent.get(`/api/export/download/${jobId}`);
      expect(download.status).toBe(200);
      expect(download.text).toBe("zip-bytes");
      expect((await w.agent.get(`/api/export/download/${jobId}`)).status).toBe(400);
    });
  });

  it("fails an empty download archive and reports a stream failure as 500", async () => {
    await withFactoryWorld(async (w) => {
      h.archive.mockResolvedValueOnce({ filePath: missingZip(), names: [], skipped: [], bytesWritten: 0 });
      const empty = await finishedJob(w, { mode: "download" });
      expect(empty.job.error).toMatch(/ZIP is empty/);

      h.finishRun.mockClear();
      h.archive.mockResolvedValueOnce({ filePath: missingZip(), names: ["A"], skipped: [], bytesWritten: 10 });
      h.stream.mockRejectedValueOnce(new Error("archive vanished"));
      const { jobId } = await finishedJob(w, { mode: "download" });
      const res = await w.agent.get(`/api/export/download/${jobId}`);
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("archive vanished");
    });
  });

  it("records an unexpected archive failure on the job", async () => {
    await withFactoryWorld(async (w) => {
      h.archive.mockRejectedValueOnce(new Error("disk full"));
      h.finishRun.mockRejectedValueOnce(new Error("tracker down"));
      const { job } = await finishedJob(w, { mode: "download" });
      expect(job).toMatchObject({ status: "error", error: "disk full" });
    });
  });
});

describe("export jobs by email", () => {
  const artifact = (names: string[], sizeBytes: number) => {
    const dispose = vi.fn(async () => undefined);
    h.artifact.mockImplementation(async (_label, _companies, _from, _to, progress) => {
      progress("packing", "info");
      return { attachment: { filename: "x.zip" }, names, skipped: ["C"], sizeBytes, dispose };
    });
    return dispose;
  };

  it("sends the archive and marks the job done; an email-mode job has no download", async () => {
    await withFactoryWorld(async (w) => {
      const dispose = artifact(["A"], 4096);
      h.send.mockResolvedValue({ success: true });
      const { jobId, job } = await finishedJob(w, { mode: "email" });
      expect(job.status).toBe("done");
      expect(h.finishRun).toHaveBeenCalledWith(77, { status: "success", emailSuccess: true, emailAttempts: 1 });
      expect(dispose).toHaveBeenCalled();
      expect((await w.agent.get(`/api/export/download/${jobId}`)).status).toBe(400);
    });
  });

  it("fails without retrying on an email configuration error, and on an empty archive", async () => {
    await withFactoryWorld(async (w) => {
      artifact(["A"], 10);
      h.send.mockResolvedValue({ success: false, error: "Email not configured" });
      const { job } = await finishedJob(w, { mode: "email" });
      expect(job).toMatchObject({ status: "error", error: "Email not configured" });
      expect(h.send).toHaveBeenCalledTimes(1);

      h.finishRun.mockClear();
      const dispose = artifact([], 0);
      const empty = await finishedJob(w, { mode: "email" });
      expect(empty.job.error).toMatch(/Nothing will be sent/);
      expect(dispose).toHaveBeenCalled();
    });
  }, 15000);
});
