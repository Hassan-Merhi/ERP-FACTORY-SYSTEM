/**
 * Authenticated private training-media playback. Only an exact, code-reviewed
 * published object key can be requested. No S3 credentials are returned.
 */
import type { Express, Request, Response } from "express";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import published from "@shared/publishedTrainingMedia.json";
import { requireAuth } from "../auth";
import { authorizeFactoryPageAccess } from "../lib/factoryAccessControl";
import { getErpUserPageAccess } from "../storage/auth";
import { effectiveErpPageKeys } from "../services/security/erpViewerPagePolicy";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { companies } from "@shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db";

type PublishedMedia = { videoKey: string; captionsKey?: string; screenshotKey?: string; sourceSha?: string; publishedAt?: string };
const registry: Record<string, PublishedMedia> = published as Record<string, PublishedMedia>;
const OBJECT_KEY = /^training\/videos\/[a-z0-9-]+\/[a-f0-9]{40}\.(?:webm|vtt|png)$/;
const TOPIC_ID = /^[a-z0-9-]{1,80}$/;
const EMPTY_HASH = createHash("sha256").update("").digest("hex");

/** Mirrors the non-sensitive, public guide catalog: server-side permission check. */
const PAGE_FOR_TOPIC: Readonly<Record<string, { mode: "erp" | "factory"; key?: string }>> = {
  "factory-overview": { mode: "factory", key: "factory/production-report" },
  "factory-stock-entry": { mode: "factory", key: "factory/stock-entry" },
  "factory-raw-materials": { mode: "factory", key: "factory/raw-materials" },
  "factory-bale-explorer": { mode: "factory", key: "factory/bales-hub" },
  "factory-containers": { mode: "factory", key: "factory/containers-hub" },
  "factory-stock-allocation": { mode: "factory", key: "factory/stock-allocation-v5" },
  "factory-invoicing": { mode: "factory", key: "factory/invoicing" },
  "factory-payroll": { mode: "factory", key: "factory/payroll-hub" },
  "factory-accounts": { mode: "factory", key: "factory/accounts" },
  "factory-analytics": { mode: "factory", key: "factory/analytics" },
  "erp-tracking": { mode: "erp" },
  "erp-inventory": { mode: "erp", key: "location_inventory" },
  "erp-pos": { mode: "erp", key: "pos" },
  "erp-vouchers": { mode: "erp", key: "vouchers" },
  "erp-daybook": { mode: "erp", key: "daybook" },
  "erp-reports": { mode: "erp", key: "sales_report" },
};

async function canStreamTopic(req: Request, topic: string): Promise<boolean> {
  const destination = PAGE_FOR_TOPIC[topic];
  if (!destination) return false;
  const context = await getActiveCompanyPermissionContext(req);
  const [company] = await db.select({ companyType: companies.companyType }).from(companies)
    .where(eq(companies.id, context.companyId)).limit(1);
  const isFactory = company?.companyType === "factory" || company?.companyType === "factory_v2";
  if (destination.mode === "factory" && !isFactory) return false;
  if (destination.mode === "erp" && isFactory) return false;
  if (!destination.key) return true;
  if (destination.mode === "factory") {
    const decision = await authorizeFactoryPageAccess(req, destination.key);
    return decision.allowed;
  }
  if (["Admin", "Owner", "Developer"].includes(context.role)) return true;
  const saved = await getErpUserPageAccess(context.companyId, context.userId);
  return effectiveErpPageKeys(context.role, saved).includes(destination.key);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

function storageConfig() {
  const endpoint = process.env.TRAINING_MEDIA_S3_ENDPOINT || "";
  const bucket = process.env.TRAINING_MEDIA_S3_BUCKET || "";
  const accessKey = process.env.TRAINING_MEDIA_S3_ACCESS_KEY || "";
  const secretKey = process.env.TRAINING_MEDIA_S3_SECRET_KEY || "";
  const region = process.env.TRAINING_MEDIA_S3_REGION || "auto";
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !/^[a-z0-9.-]+$/i.test(bucket) || !/^[a-z0-9-]+$/i.test(region)) return null;
  return { url, bucket, accessKey, secretKey, region };
}

export function signedTrainingObjectRequest(key: string, range?: string): { url: string; headers: Record<string, string> } | null {
  const cfg = storageConfig();
  if (!cfg || !OBJECT_KEY.test(key)) return null;
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const scope = day + "/" + cfg.region + "/s3/aws4_request";
  const canonicalPath = "/" + cfg.bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
  const canonicalHeaders = "host:" + cfg.url.host + "\nx-amz-content-sha256:" + EMPTY_HASH + "\nx-amz-date:" + date + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", canonicalPath, "", canonicalHeaders, signedHeaders, EMPTY_HASH].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretKey, day), cfg.region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const headers: Record<string, string> = {
    "x-amz-date": date,
    "x-amz-content-sha256": EMPTY_HASH,
    "authorization": "AWS4-HMAC-SHA256 Credential=" + cfg.accessKey + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
  if (range) headers.range = range;
  return { url: cfg.url.origin + canonicalPath, headers };
}

async function streamMedia(req: Request, res: Response, kind: "video" | "captions" | "screenshot") {
  const topic = String(req.params.topic || "");
  if (!TOPIC_ID.test(topic) || !Object.prototype.hasOwnProperty.call(registry, topic)) {
    res.status(404).json({ message: "Training media not published" });
    return;
  }
  try {
    if (!(await canStreamTopic(req, topic))) {
      res.status(403).json({ message: "Training page access is required" });
      return;
    }
  } catch {
    res.status(503).json({ message: "Training access could not be verified" });
    return;
  }
  const entry = registry[topic];
  const key = kind === "video" ? entry.videoKey : kind === "captions" ? entry.captionsKey : entry.screenshotKey;
  if (!key || !OBJECT_KEY.test(key) || !key.endsWith(kind === "video" ? ".webm" : kind === "captions" ? ".vtt" : ".png")) {
    res.status(404).json({ message: "Training media not published" });
    return;
  }
  const range = req.headers.range;
  if (range && (kind !== "video" || !/^bytes=\d+-\d*$/.test(range) || range.length > 80)) {
    res.status(416).end();
    return;
  }
  const request = signedTrainingObjectRequest(key, range);
  if (!request) {
    res.status(503).json({ message: "Training media storage is not configured" });
    return;
  }
  try {
    const upstream = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(30_000) });
    if (![200, 206].includes(upstream.status) || !upstream.body) {
      res.status(upstream.status === 404 ? 404 : 502).json({ message: "Training media temporarily unavailable" });
      return;
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", kind === "video" ? "video/webm" : kind === "captions" ? "text/vtt; charset=utf-8" : "image/png");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    const source = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream);
    source.on("error", () => { if (!res.headersSent) res.status(502); res.destroy(); });
    res.on("close", () => source.destroy());
    source.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ message: "Training media temporarily unavailable" });
    else res.end();
  }
}

export function registerTrainingMediaRoutes(app: Express): void {
  app.get("/api/training/media/:topic", requireAuth, (req, res) => { void streamMedia(req, res, "video"); });
  app.get("/api/training/media/:topic/captions", requireAuth, (req, res) => { void streamMedia(req, res, "captions"); });
  app.get("/api/training/media/:topic/screenshot", requireAuth, (req, res) => { void streamMedia(req, res, "screenshot"); });
}
