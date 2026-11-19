/**
 * Authenticated training-media listing and playback
 * (server/routes/trainingMediaRoutes.ts) over HTTP. The Vercel gateway, the
 * private blob store and the runtime manifest are all reached through global
 * fetch, which is stubbed here; no network call is made. Covers per-page
 * access (ERP grants, POS, Developer-only, Factory and Supplier Partner
 * companies), the unpublished/forbidden/unconfigured refusals, byte ranges and
 * every upstream failure mapping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pool } from "../server/db";
import { resetPublishedTrainingRegistryCache } from "../server/routes/trainingMediaRoutes";
import { TRAINING_MANIFEST_KEY } from "../shared/trainingMediaManifest";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { createRoleUser, signInAdmin, signInAs, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "trnmedia";
const GATEWAY = "https://erp-training-storage-access.vercel.app";
const BLOB = "https://txyfgtsysrceqhoj.private.blob.vercel-storage.com";
const key = (topic: string, ext: string) => `training/videos/${topic}/${"a".repeat(40)}.${ext}`;
const MANIFEST: Record<string, Record<string, unknown>> = {
  "erp-tracking": {
    videoKey: key("erp-tracking", "mp4"),
    captionsKey: key("erp-tracking", "vtt"),
    screenshotKey: key("erp-tracking", "png"),
    guideSteps: ["Open tracking"],
    sourceSha: "b".repeat(40),
    publishedAt: "2026-01-01T00:00:00Z",
    durationSeconds: 12,
  },
  "erp-vouchers": { videoKey: key("erp-vouchers", "webm") },
  "factory-overview": { videoKey: key("factory-overview", "mp4") },
  "custom-daybook": { videoKey: key("custom-daybook", "mp4"), route: "/transaction-journal" },
  "custom-open-page": { videoKey: key("custom-open-page", "mp4"), route: "/no-grant-page" },
  "custom-dev": { videoKey: key("custom-dev", "mp4"), route: "/cost-centers" },
  "custom-pos": { videoKey: key("custom-pos", "mp4"), route: "/pos" },
  "custom-sp": { videoKey: key("custom-sp", "mp4"), route: "/sp/home" },
  "custom-factory-bad": { videoKey: key("custom-factory-bad", "mp4"), route: "/factory/zz-not-a-page" },
  orphan: { videoKey: key("orphan", "mp4") },
};

type Handler = (key: string, headers: Record<string, string>) => Response | Promise<Response>;
const net: { manifest: () => Response; media: Handler; grant: (key: string) => Response } = {
  manifest: () => Response.json(MANIFEST),
  media: () => new Response("0123456789", { status: 200, headers: { "content-length": "10" } }),
  grant: (k) => Response.json({ url: `${BLOB}/${k}?vercel-blob-delegation=d&vercel-blob-signature=s` }),
};
const fetchStub = vi.fn(async (input: string | URL, init?: { headers?: Record<string, string> }) => {
  const url = String(input);
  if (url.startsWith(`${GATEWAY}/api/sign?key=`)) return net.grant(decodeURIComponent(url.split("key=")[1]));
  const path = new URL(url).pathname.slice(1);
  if (path === TRAINING_MANIFEST_KEY) return net.manifest();
  return net.media(path, init?.headers ?? {});
});

const ENV = {
  TRAINING_MEDIA_PROVIDER: "vercel",
  TRAINING_MEDIA_GATEWAY_URL: GATEWAY,
  TRAINING_GATEWAY_READ_SECRET: "s".repeat(48),
};
const savedEnv: Record<string, string | undefined> = {};
let ctx: TestContext;
let admin: Agent;

function resetNet() {
  net.manifest = () => Response.json(MANIFEST);
  net.media = () => new Response("0123456789", { status: 200, headers: { "content-length": "10" } });
  net.grant = (k) => Response.json({ url: `${BLOB}/${k}?vercel-blob-delegation=d&vercel-blob-signature=s` });
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  vi.stubGlobal("fetch", fetchStub);
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
}, 60000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPublishedTrainingRegistryCache();
  await pool.query("DELETE FROM erp_user_page_access WHERE company_id=$1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

beforeEach(() => {
  resetNet();
  resetPublishedTrainingRegistryCache();
});

async function topics(agent: Agent): Promise<string[]> {
  const res = await agent.get("/api/training/media");
  expect(res.status).toBe(200);
  return Object.keys(res.body.topics).sort();
}

async function withCompanyType<T>(type: string, work: () => Promise<T>): Promise<T> {
  await pool.query("UPDATE companies SET company_type=$1 WHERE id=$2", [type, ctx.companyId]);
  try {
    return await work();
  } finally {
    await pool.query("UPDATE companies SET company_type='erp' WHERE id=$1", [ctx.companyId]);
  }
}

describe("listing", () => {
  it("refuses anonymous callers", async () => {
    expect((await request(ctx.app).get("/api/training/media")).status).toBe(401);
  });

  it("lists only the ERP pages an Admin may open, with entry details", async () => {
    const res = await admin.get("/api/training/media");
    expect(res.body.provider).toBe("vercel");
    expect(Object.keys(res.body.topics).sort()).toEqual(
      ["custom-daybook", "custom-open-page", "custom-pos", "erp-tracking", "erp-vouchers"].sort()
    );
    expect(res.body.topics["erp-tracking"]).toEqual({
      guideSteps: ["Open tracking"],
      captions: true,
      screenshot: true,
      sourceSha: "b".repeat(40),
      publishedAt: "2026-01-01T00:00:00Z",
      durationSeconds: 12,
      route: null,
    });
    expect(res.body.topics["erp-vouchers"]).toMatchObject({ captions: false, sourceSha: null, route: null });
  });

  it("follows ERP page grants for ordinary users", async () => {
    const granted = await createRoleUser(ctx, PREFIX, "Manager");
    await pool.query("INSERT INTO erp_user_page_access(company_id,user_id,page_key) VALUES($1,$2,'daybook')", [
      ctx.companyId,
      granted.userId,
    ]);
    const manager = await signInAs(ctx, granted.username);
    expect(await topics(manager)).toEqual(["custom-daybook", "custom-open-page", "erp-tracking"]);
    const bare = await signInRole(ctx, PREFIX, "Manager");
    expect(await topics(bare)).toEqual(["erp-tracking"]);
    expect((await bare.get("/api/training/media/erp-vouchers")).status).toBe(403);
  });

  it("gives POS users only POS pages and Developers the developer-only pages", async () => {
    const pos = await signInRole(ctx, PREFIX, "POS", [], { assignedLocationId: ctx.locationId });
    expect(await topics(pos)).toEqual(["custom-pos", "erp-tracking"]);
    const developer = await signInRole(ctx, PREFIX, "Developer");
    expect(await topics(developer)).toContain("custom-dev");
  });

  it("shows factory recordings only in a factory company and partner recordings only to partners", async () => {
    await withCompanyType("factory", async () => {
      const listed = await topics(admin);
      expect(listed).toContain("factory-overview");
      expect(listed).not.toContain("erp-tracking");
    });
    await withCompanyType("supplier_partner", async () => {
      expect(await topics(admin)).toContain("custom-sp");
    });
  });

  it("treats a missing runtime manifest as an empty library, and keeps the build fallback on failure", async () => {
    net.manifest = () => new Response("", { status: 404 });
    expect(await topics(admin)).toEqual([]);
    resetPublishedTrainingRegistryCache();
    net.manifest = () => new Response("", { status: 500 });
    expect(await topics(admin)).toEqual([]);
    resetPublishedTrainingRegistryCache();
    net.manifest = () => new Response("x".repeat(300 * 1024));
    expect(await topics(admin)).toEqual([]);
    resetPublishedTrainingRegistryCache();
    net.grant = () => new Response("", { status: 403 });
    expect(await topics(admin)).toEqual([]);
  });

  it("re-uses the cached manifest until it expires", async () => {
    await topics(admin);
    const calls = fetchStub.mock.calls.length;
    await topics(admin);
    expect(fetchStub.mock.calls.length).toBe(calls);
  });
});

describe("playback refusals", () => {
  it("refuses unpublished, malformed, forbidden and unconfigured media", async () => {
    expect((await admin.get("/api/training/media/not-published")).status).toBe(404);
    expect((await admin.get("/api/training/media/Bad_Topic")).status).toBe(404);
    expect((await admin.get("/api/training/media/factory-overview")).status).toBe(403);
    expect((await admin.get("/api/training/media/orphan")).status).toBe(403);
    expect((await admin.get("/api/training/media/erp-vouchers/captions")).status).toBe(404);
    expect((await admin.get("/api/training/media/erp-vouchers/screenshot")).status).toBe(404);
    net.grant = () => new Response("", { status: 500 });
    const unconfigured = await admin.get("/api/training/media/erp-vouchers");
    expect([unconfigured.status, unconfigured.body.message]).toEqual([503, "Training media storage is not configured"]);
  });

  it("refuses a range on captions and a malformed video range", async () => {
    expect((await admin.get("/api/training/media/erp-tracking/captions").set("Range", "bytes=0-1")).status).toBe(416);
    expect((await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=5-1")).status).toBe(416);
  });

  it("refuses a gateway grant that points anywhere but the private store", async () => {
    for (const body of [
      { url: 7 },
      { url: "https://evil.example.com/x?vercel-blob-delegation=1&vercel-blob-signature=2" },
    ]) {
      resetPublishedTrainingRegistryCache();
      net.grant = (k) =>
        k === TRAINING_MANIFEST_KEY
          ? Response.json({ url: `${BLOB}/${k}?vercel-blob-delegation=d&vercel-blob-signature=s` })
          : Response.json(body);
      expect((await admin.get("/api/training/media/erp-tracking")).status).toBe(503);
    }
  });
});

describe("playback", () => {
  it("streams whole files with the right content type", async () => {
    const video = await admin.get("/api/training/media/erp-tracking");
    expect(video.status).toBe(200);
    expect(video.headers["content-type"]).toBe("video/mp4");
    expect(video.headers["content-length"]).toBe("10");
    const webm = await admin.get("/api/training/media/erp-vouchers");
    expect(webm.headers["content-type"]).toBe("video/webm");
    net.media = () => new Response("WEBVTT", { status: 200 });
    const captions = await admin.get("/api/training/media/erp-tracking/captions");
    expect([captions.status, captions.text]).toEqual([200, "WEBVTT"]);
    expect(captions.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    net.media = () => new Response("PNG", { status: 200, headers: { "content-length": "3" } });
    const shot = await admin.get("/api/training/media/erp-tracking/screenshot").buffer(true);
    expect(shot.headers["content-type"]).toBe("image/png");
  });

  it("serves exact byte ranges from a 206 reply and cuts a full reply down to the range", async () => {
    net.media = (_k, headers) => {
      expect(headers.range).toBe("bytes=2-4");
      return new Response("234", { status: 206, headers: { "content-range": "bytes 2-4/10", "content-length": "3" } });
    };
    const partial = await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=2-4");
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toBe("bytes 2-4/10");
    net.media = () => new Response("0123456789", { status: 200, headers: { "content-length": "10" } });
    const cut = await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=-3").buffer(true);
    expect(cut.status).toBe(206);
    expect(cut.headers["content-range"]).toBe("bytes 7-9/10");
  });

  it("maps upstream refusals and failures", async () => {
    net.media = () => new Response("", { status: 416, headers: { "content-range": "bytes */10" } });
    const unsatisfiable = await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=50-60");
    expect([unsatisfiable.status, unsatisfiable.headers["content-range"]]).toEqual([416, "bytes */10"]);
    net.media = () => new Response("", { status: 416 });
    expect((await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=50-60")).status).toBe(416);
    net.media = () => new Response("", { status: 404 });
    expect((await admin.get("/api/training/media/erp-tracking")).status).toBe(404);
    net.media = () => new Response("", { status: 500 });
    expect((await admin.get("/api/training/media/erp-tracking")).status).toBe(502);
    net.media = () => new Response("34", { status: 206 });
    expect((await admin.get("/api/training/media/erp-tracking").set("Range", "bytes=3-4")).status).toBe(502);
    net.media = () => {
      throw new Error("connection reset");
    };
    expect((await admin.get("/api/training/media/erp-tracking")).status).toBe(502);
  });
});
