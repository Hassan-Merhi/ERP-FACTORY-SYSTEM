/**
 * Storage request signing and access-check failure handling in
 * server/routes/trainingMediaRoutes.ts: the S3 (SigV4) signer refuses every
 * unsafe configuration, the Vercel gateway client refuses an unapproved
 * gateway or short secret and re-uses fresh grants, and a permission lookup
 * failure is a 503 on playback and a silent omission from the listing.
 * fetch and the permission context are stubbed; no network or database call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ fail: false }));
vi.mock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/security/activeCompanyPermissionContext")>();
  return {
    ...actual,
    getActiveCompanyPermissionContext: async () => {
      if (access.fail) throw new Error("permission store offline");
      return { userId: "u1", companyId: 1, role: "Admin" };
    },
  };
});

import {
  authenticatedVercelTrainingObjectRequest,
  loadPublishedTrainingRegistry,
  registerTrainingMediaRoutes,
  resetPublishedTrainingRegistryCache,
  signedTrainingObjectRequest,
} from "../server/routes/trainingMediaRoutes";
import { TRAINING_MANIFEST_KEY } from "../shared/trainingMediaManifest";

const GATEWAY = "https://erp-training-storage-access.vercel.app";
const KEY = `training/videos/erp-tracking/${"c".repeat(40)}.mp4`;
const S3_ENV = [
  "TRAINING_MEDIA_S3_ENDPOINT",
  "TRAINING_MEDIA_S3_BUCKET",
  "TRAINING_MEDIA_S3_ACCESS_KEY",
  "TRAINING_MEDIA_S3_SECRET_KEY",
  "TRAINING_MEDIA_S3_REGION",
  "TRAINING_MEDIA_S3_URL_STYLE",
  "TRAINING_MEDIA_PROVIDER",
  "TRAINING_MEDIA_GATEWAY_URL",
  "TRAINING_GATEWAY_READ_SECRET",
];
const saved = Object.fromEntries(S3_ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of S3_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  resetPublishedTrainingRegistryCache();
  access.fail = false;
});

function s3(env: Partial<Record<string, string>>) {
  Object.assign(process.env, {
    TRAINING_MEDIA_S3_ENDPOINT: "https://storage.example.com/",
    TRAINING_MEDIA_S3_BUCKET: "training-bucket",
    TRAINING_MEDIA_S3_ACCESS_KEY: "AKIA",
    TRAINING_MEDIA_S3_SECRET_KEY: "secret",
    ...env,
  });
}

describe("S3 signed object requests", () => {
  it("signs a path-style request with a forwarded range", () => {
    s3({});
    const req = signedTrainingObjectRequest(KEY, "bytes=0-9");
    expect(req?.url).toBe(`https://storage.example.com/training-bucket/${KEY}`);
    expect(req?.headers.range).toBe("bytes=0-9");
    expect(req?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
    );
  });

  it("signs a virtual-host request against the bucket host", () => {
    s3({ TRAINING_MEDIA_S3_URL_STYLE: "virtual-host", TRAINING_MEDIA_S3_REGION: "eu-west-1" });
    const req = signedTrainingObjectRequest(KEY);
    expect(req?.url).toBe(`https://training-bucket.storage.example.com/${KEY}`);
    expect(req?.headers.range).toBeUndefined();
  });

  it("refuses incomplete or unsafe storage configuration and unknown keys", () => {
    expect(signedTrainingObjectRequest(KEY)).toBeNull();
    const unsafe: Array<Partial<Record<string, string>>> = [
      { TRAINING_MEDIA_S3_ENDPOINT: "not a url" },
      { TRAINING_MEDIA_S3_ENDPOINT: "http://storage.example.com/" },
      { TRAINING_MEDIA_S3_ENDPOINT: "https://user:pw@storage.example.com/" },
      { TRAINING_MEDIA_S3_ENDPOINT: "https://storage.example.com/prefix" },
      { TRAINING_MEDIA_S3_ENDPOINT: "https://storage.example.com/?a=1" },
      { TRAINING_MEDIA_S3_ENDPOINT: "https://storage.example.com/#x" },
      { TRAINING_MEDIA_S3_BUCKET: "A" },
      { TRAINING_MEDIA_S3_REGION: "eu west" },
      { TRAINING_MEDIA_S3_URL_STYLE: "dns" },
      { TRAINING_MEDIA_S3_URL_STYLE: "virtual-host", TRAINING_MEDIA_S3_BUCKET: "training.bucket" },
    ];
    for (const env of unsafe) {
      s3(env);
      expect(signedTrainingObjectRequest(KEY), JSON.stringify(env)).toBeNull();
      for (const k of S3_ENV) delete process.env[k];
    }
    s3({});
    expect(signedTrainingObjectRequest("training/videos/x/../../secrets.mp4")).toBeNull();
  });
});

describe("Vercel gateway grants", () => {
  const BLOB = "https://txyfgtsysrceqhoj.private.blob.vercel-storage.com";

  it("refuses an unapproved gateway, a short secret or an unknown key without calling it", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    process.env.TRAINING_MEDIA_GATEWAY_URL = "https://evil.example.com";
    process.env.TRAINING_GATEWAY_READ_SECRET = "s".repeat(48);
    expect(await authenticatedVercelTrainingObjectRequest(KEY)).toBeNull();
    process.env.TRAINING_MEDIA_GATEWAY_URL = GATEWAY;
    process.env.TRAINING_GATEWAY_READ_SECRET = "short";
    expect(await authenticatedVercelTrainingObjectRequest(KEY)).toBeNull();
    process.env.TRAINING_GATEWAY_READ_SECRET = "s".repeat(48);
    expect(await authenticatedVercelTrainingObjectRequest("training/other.txt")).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("signs the gateway call, caches media grants but never the manifest", async () => {
    process.env.TRAINING_MEDIA_GATEWAY_URL = GATEWAY;
    process.env.TRAINING_GATEWAY_READ_SECRET = "s".repeat(48);
    const fetchStub = vi.fn(async (url: string) => {
      const k = decodeURIComponent(url.split("key=")[1]);
      return Response.json({ url: `${BLOB}/${k}?vercel-blob-delegation=d&vercel-blob-signature=s` });
    });
    vi.stubGlobal("fetch", fetchStub);
    const first = await authenticatedVercelTrainingObjectRequest(KEY, "bytes=0-1");
    expect(first?.headers).toEqual({ range: "bytes=0-1" });
    const headers = (fetchStub.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers["x-training-signature"]).toMatch(/^[0-9a-f]{64}$/);
    const again = await authenticatedVercelTrainingObjectRequest(KEY);
    expect(again).toEqual({ url: first?.url, headers: {} });
    await authenticatedVercelTrainingObjectRequest(TRAINING_MANIFEST_KEY);
    await authenticatedVercelTrainingObjectRequest(TRAINING_MANIFEST_KEY);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("refuses grants without the blob delegation parameters, and network errors", async () => {
    process.env.TRAINING_MEDIA_GATEWAY_URL = GATEWAY;
    process.env.TRAINING_GATEWAY_READ_SECRET = "s".repeat(48);
    vi.stubGlobal("fetch", async () => Response.json({ url: `${BLOB}/${KEY}` }));
    expect(await authenticatedVercelTrainingObjectRequest(KEY)).toBeNull();
    vi.stubGlobal("fetch", async () =>
      Response.json({ url: `http://txyfgtsysrceqhoj.private.blob.vercel-storage.com/${KEY}` })
    );
    expect(await authenticatedVercelTrainingObjectRequest(KEY)).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await authenticatedVercelTrainingObjectRequest(KEY)).toBeNull();
  });
});

describe("registry and access-check failures", () => {
  it("serves the build-time registry without the Vercel provider", async () => {
    delete process.env.TRAINING_MEDIA_PROVIDER;
    expect(await loadPublishedTrainingRegistry()).toEqual({});
  });

  it("answers 503 on playback and omits the topic from the listing when access cannot be checked", async () => {
    process.env.TRAINING_MEDIA_PROVIDER = "vercel";
    process.env.TRAINING_MEDIA_GATEWAY_URL = GATEWAY;
    process.env.TRAINING_GATEWAY_READ_SECRET = "s".repeat(48);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/api/sign")) {
        return Response.json({
          url: `https://txyfgtsysrceqhoj.private.blob.vercel-storage.com/${TRAINING_MANIFEST_KEY}?vercel-blob-delegation=d&vercel-blob-signature=s`,
        });
      }
      return Response.json({ "erp-tracking": { videoKey: KEY } });
    });
    const handlers = new Map<string, (req: unknown, res: unknown) => void>();
    registerTrainingMediaRoutes({
      get: (path: string, ...chain: Array<(req: unknown, res: unknown) => void>) => handlers.set(path, chain.at(-1)!),
    } as never);
    access.fail = true;
    const call = (path: string, params: Record<string, string> = {}) =>
      new Promise<{ status: number; body: unknown }>((resolve) => {
        let status = 200;
        const res = {
          status(code: number) {
            status = code;
            return res;
          },
          setHeader: () => res,
          json(body: unknown) {
            resolve({ status, body });
          },
        };
        handlers.get(path)!({ params, headers: {}, session: {} }, res);
      });
    expect(await call("/api/training/media/:topic", { topic: "erp-tracking" })).toEqual({
      status: 503,
      body: { message: "Training access could not be verified" },
    });
    expect(await call("/api/training/media")).toEqual({ status: 200, body: { provider: "vercel", topics: {} } });
  });
});
