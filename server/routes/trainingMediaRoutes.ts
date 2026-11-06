/**
 * Authenticated private training-media playback. Only an exact, code-reviewed
 * published object key can be requested. No storage credentials are returned.
 */
import type { Express, Request, Response } from "express";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { byteWindow, parseByteRange, planMediaResponse } from "./trainingMediaRange";
import published from "@shared/publishedTrainingMedia.json";
import {
  MAX_TRAINING_MANIFEST_BYTES,
  TRAINING_MANIFEST_KEY,
  parsePublishedTrainingManifest,
  type PublishedTrainingManifest,
} from "@shared/trainingMediaManifest";
import { requireAuth } from "../auth";
import { authorizeFactoryPageAccess } from "../lib/factoryAccessControl";
import { getErpUserPageAccess } from "../storage/auth";
import { effectiveErpPageKeys } from "../services/security/erpViewerPagePolicy";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { companies } from "@shared/schema";
import { resolveFactoryPageKey } from "@shared/factoryAccessRegistry";
import {
  ERP_POS_ROLE_ROUTES,
  canonicalErpAccessPath,
  getErpRouteFeatureKeys,
  isErpDeveloperOnlyRoute,
} from "@shared/erpRouteAccess";
import { eq } from "drizzle-orm";
import { db } from "../db";

/** Entries baked into the build: the fallback when no runtime manifest exists. */
const staticRegistry: PublishedTrainingManifest = parsePublishedTrainingManifest(published);
const MANIFEST_TTL_MS = 60_000;
const MANIFEST_RETRY_MS = 15_000;
let cachedRegistry: { registry: PublishedTrainingManifest; expiresAt: number } | null = null;
let registryInFlight: Promise<PublishedTrainingManifest> | null = null;

async function fetchRuntimeManifest(): Promise<PublishedTrainingManifest> {
  const request = await authenticatedVercelTrainingObjectRequest(TRAINING_MANIFEST_KEY);
  if (!request) throw new Error("training_manifest.gateway_unconfigured");
  const upstream = await fetch(request.url, {
    headers: request.headers,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  // Nothing has been published yet: an empty library, not an error.
  if (upstream.status === 404) return {};
  if (!upstream.ok) throw new Error("training_manifest.unavailable");
  const text = await upstream.text();
  if (text.length > MAX_TRAINING_MANIFEST_BYTES) throw new Error("training_manifest.too_large");
  return parsePublishedTrainingManifest(JSON.parse(text));
}

/**
 * The nightly audit replaces the manifest in private storage, so the server
 * re-reads it about once a minute instead of needing a deploy. A failed read
 * keeps the last good manifest and retries shortly after.
 */
export async function loadPublishedTrainingRegistry(): Promise<PublishedTrainingManifest> {
  if (process.env.TRAINING_MEDIA_PROVIDER !== "vercel") return staticRegistry;
  if (cachedRegistry && Date.now() < cachedRegistry.expiresAt) return cachedRegistry.registry;
  if (!registryInFlight) {
    registryInFlight = fetchRuntimeManifest()
      .then((registry) => {
        cachedRegistry = { registry, expiresAt: Date.now() + MANIFEST_TTL_MS };
        return registry;
      })
      .catch(() => {
        const registry = cachedRegistry?.registry ?? staticRegistry;
        cachedRegistry = { registry, expiresAt: Date.now() + MANIFEST_RETRY_MS };
        return registry;
      })
      .finally(() => {
        registryInFlight = null;
      });
  }
  return registryInFlight;
}

/** Test hook: forget the cached manifest. */
export function resetPublishedTrainingRegistryCache(): void {
  cachedRegistry = null;
  registryInFlight = null;
  grantCache.clear();
}
const OBJECT_KEY = /^training\/videos\/[a-z0-9-]+\/[a-f0-9]{40}\.(?:webm|mp4|vtt|png)$/;
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

type TopicDestination = {
  mode: "erp" | "factory" | "sp";
  key?: string;
  erpKeys?: readonly string[];
  route?: string;
};

/**
 * Where a published recording leads. The original tours keep their reviewed
 * mapping; recordings of any other page carry its route in the manifest and
 * follow that page's own permission (Factory registry key, ERP page grants,
 * or the Supplier Partner workspace).
 */
function destinationFor(topic: string, route: string | undefined): TopicDestination | null {
  const reviewed = PAGE_FOR_TOPIC[topic];
  if (reviewed) return reviewed;
  if (!route) return null;
  if (route.startsWith("/factory/")) {
    const key = resolveFactoryPageKey(route);
    return key ? { mode: "factory", key } : null;
  }
  if (route === "/sp" || route.startsWith("/sp/")) return { mode: "sp" };
  return { mode: "erp", erpKeys: getErpRouteFeatureKeys(route), route: canonicalErpAccessPath(route) };
}

async function canStreamTopic(req: Request, topic: string, route?: string): Promise<boolean> {
  const destination = destinationFor(topic, route);
  if (!destination) return false;
  const context = await getActiveCompanyPermissionContext(req);
  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, context.companyId))
    .limit(1);
  const isFactory = company?.companyType === "factory" || company?.companyType === "factory_v2";
  const isSupplierPartner = company?.companyType === "supplier_partner";
  if (destination.mode === "factory" && !isFactory) return false;
  if (destination.mode === "erp" && isFactory) return false;
  if (destination.mode === "sp") return isSupplierPartner;
  if (destination.erpKeys && destination.route) {
    // Same rule as the ERP sidebar (AppSidebar isItemVisible).
    if (isErpDeveloperOnlyRoute(destination.route)) return context.role === "Developer";
    if (["Admin", "Owner", "Developer"].includes(context.role)) return true;
    if (context.role === "POS") return ERP_POS_ROLE_ROUTES.includes(destination.route);
    const granted = effectiveErpPageKeys(context.role, await getErpUserPageAccess(context.companyId, context.userId));
    if (destination.erpKeys.length > 0) return destination.erpKeys.some((key) => granted.includes(key));
    // A page without its own grant is open to anyone who has been given any ERP page.
    return granted.length > 0;
  }
  if (!destination.key) return true;
  if (destination.mode === "factory") {
    const decision = await authorizeFactoryPageAccess(req, destination.key);
    return decision.allowed;
  }
  if (["Admin", "Owner", "Developer"].includes(context.role)) return true;
  const saved = await getErpUserPageAccess(context.companyId, context.userId);
  return effectiveErpPageKeys(context.role, saved).includes(destination.key);
}

/**
 * The authenticated ERP server never holds Vercel Blob credentials. It grants
 * one signed read per approved immutable media key through the OIDC gateway.
 * Vercel's short-lived object URL is consumed on the server (not sent to users).
 */
const GRANT_REUSE_MS = 40_000; // the gateway's read URLs live 60 s
const grantCache = new Map<string, { url: string; expiresAt: number }>();

export async function authenticatedVercelTrainingObjectRequest(
  key: string,
  range?: string
): Promise<{ url: string; headers: Record<string, string> } | null> {
  // A video player issues many byte-range requests per play; reuse a fresh
  // grant instead of a gateway round trip (about a second) for every one.
  const cached = key === TRAINING_MANIFEST_KEY ? undefined : grantCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return { url: cached.url, headers: range ? { range } : {} };
  const gatewayUrl = process.env.TRAINING_MEDIA_GATEWAY_URL || "";
  const secret = process.env.TRAINING_GATEWAY_READ_SECRET || "";
  const approvedGateway = "https://erp-training-storage-access.vercel.app";
  if (
    gatewayUrl !== approvedGateway ||
    secret.length < 40 ||
    !(OBJECT_KEY.test(key) || key === TRAINING_MANIFEST_KEY)
  ) {
    return null;
  }
  const time = Date.now().toString();
  const signature = createHmac("sha256", secret)
    .update("GET\n" + key + "\n" + time)
    .digest("hex");
  try {
    const requestUrl = approvedGateway + "/api/sign?key=" + encodeURIComponent(key);
    const grant = await fetch(requestUrl, {
      headers: { "x-training-time": time, "x-training-signature": signature },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!grant.ok) return null;
    const body = (await grant.json()) as { url?: unknown };
    if (typeof body.url !== "string" || body.url.length > 8000) return null;
    const url = new URL(body.url);
    if (
      url.protocol !== "https:" ||
      url.host !== "txyfgtsysrceqhoj.private.blob.vercel-storage.com" ||
      url.pathname !== "/" + key ||
      !url.searchParams.has("vercel-blob-delegation") ||
      !url.searchParams.has("vercel-blob-signature")
    )
      return null;
    if (key !== TRAINING_MANIFEST_KEY) {
      if (grantCache.size > 200) grantCache.clear();
      grantCache.set(key, { url: url.toString(), expiresAt: Date.now() + GRANT_REUSE_MS });
    }
    return { url: url.toString(), headers: range ? { range } : {} };
  } catch {
    return null;
  }
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
  const urlStyle = process.env.TRAINING_MEDIA_S3_URL_STYLE || "path";
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/i.test(url.hostname) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-z0-9-]+$/i.test(region) ||
    !["path", "virtual-host"].includes(urlStyle)
  )
    return null;
  // Railway Buckets use virtual-hosted-style S3 URLs; legacy S3 endpoints may use path style.
  // Block bucket names with periods for virtual-host style to avoid TLS wildcard mismatches.
  if (urlStyle === "virtual-host" && bucket.includes(".")) return null;
  return { url, bucket, accessKey, secretKey, region, urlStyle };
}

export function signedTrainingObjectRequest(
  key: string,
  range?: string
): { url: string; headers: Record<string, string> } | null {
  const cfg = storageConfig();
  if (!cfg || !OBJECT_KEY.test(key)) return null;
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const scope = day + "/" + cfg.region + "/s3/aws4_request";
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const canonicalPath = cfg.urlStyle === "virtual-host" ? "/" + encodedKey : "/" + cfg.bucket + "/" + encodedKey;
  const host = cfg.urlStyle === "virtual-host" ? cfg.bucket + "." + cfg.url.host : cfg.url.host;
  const canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + EMPTY_HASH + "\nx-amz-date:" + date + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", canonicalPath, "", canonicalHeaders, signedHeaders, EMPTY_HASH].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretKey, day), cfg.region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const headers: Record<string, string> = {
    "x-amz-date": date,
    "x-amz-content-sha256": EMPTY_HASH,
    authorization:
      "AWS4-HMAC-SHA256 Credential=" +
      cfg.accessKey +
      "/" +
      scope +
      ", SignedHeaders=" +
      signedHeaders +
      ", Signature=" +
      signature,
  };
  if (range) headers.range = range;
  return { url: cfg.url.protocol + "//" + host + canonicalPath, headers };
}

async function streamMedia(req: Request, res: Response, kind: "video" | "captions" | "screenshot") {
  const topic = String(req.params.topic || "");
  const registry = await loadPublishedTrainingRegistry();
  if (!TOPIC_ID.test(topic) || !Object.prototype.hasOwnProperty.call(registry, topic)) {
    res.status(404).json({ message: "Training media not published" });
    return;
  }
  try {
    if (!(await canStreamTopic(req, topic, registry[topic]?.route))) {
      res.status(403).json({ message: "Training page access is required" });
      return;
    }
  } catch {
    res.status(503).json({ message: "Training access could not be verified" });
    return;
  }
  const entry = registry[topic];
  const key = kind === "video" ? entry.videoKey : kind === "captions" ? entry.captionsKey : entry.screenshotKey;
  if (
    !key ||
    !OBJECT_KEY.test(key) ||
    !(kind === "video"
      ? key.endsWith(".mp4") || key.endsWith(".webm")
      : key.endsWith(kind === "captions" ? ".vtt" : ".png"))
  ) {
    res.status(404).json({ message: "Training media not published" });
    return;
  }
  const rawRange = req.headers.range;
  const range = rawRange ? parseByteRange(rawRange) : null;
  if (rawRange && (kind !== "video" || !range)) {
    res.status(416).end();
    return;
  }
  const request =
    process.env.TRAINING_MEDIA_PROVIDER === "vercel"
      ? await authenticatedVercelTrainingObjectRequest(key, range?.header)
      : signedTrainingObjectRequest(key, range?.header);
  if (!request) {
    res.status(503).json({ message: "Training media storage is not configured" });
    return;
  }
  try {
    const upstream = await fetch(request.url, {
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    if (upstream.status === 416 && range) {
      const total = /\/(\d+)$/.exec(upstream.headers.get("content-range") || "")?.[1];
      await upstream.body?.cancel().catch(() => undefined);
      if (total) res.setHeader("Content-Range", "bytes */" + total);
      res.status(416).end();
      return;
    }
    if (![200, 206].includes(upstream.status) || !upstream.body) {
      res.status(upstream.status === 404 ? 404 : 502).json({ message: "Training media temporarily unavailable" });
      return;
    }
    // Whole-file reads (captions, screenshots, non-range players) stream as-is
    // when storage omits the length; byte ranges must always be exact.
    const plan =
      planMediaResponse(range, upstream.status, upstream.headers) ??
      (!range && upstream.status === 200 ? { status: 200, length: -1, skip: 0, trim: false } : null);
    if (!plan) {
      await upstream.body.cancel().catch(() => undefined);
      res.status(502).json({ message: "Training media temporarily unavailable" });
      return;
    }
    res.status(plan.status);
    res.setHeader(
      "Content-Type",
      kind === "video"
        ? key.endsWith(".mp4")
          ? "video/mp4"
          : "video/webm"
        : kind === "captions"
          ? "text/vtt; charset=utf-8"
          : "image/png"
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    if (plan.length >= 0) res.setHeader("Content-Length", String(plan.length));
    if (plan.contentRange) res.setHeader("Content-Range", plan.contentRange);
    const body = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream);
    const source = plan.skip > 0 || plan.trim ? body.pipe(byteWindow(plan.skip, plan.length)) : body;
    if (source !== body) body.on("error", (error) => source.destroy(error));
    source.on("error", () => {
      if (!res.headersSent) res.status(502);
      res.destroy();
    });
    res.on("close", () => source.destroy());
    source.pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ message: "Training media temporarily unavailable" });
    else res.end();
  }
}

/**
 * Published topics this user may open in the active company. The same page
 * check guards playback, so the listing never advertises a video the user
 * would be refused.
 */
async function listPublished(req: Request, res: Response) {
  const registry = await loadPublishedTrainingRegistry();
  const topics: Record<string, unknown> = {};
  for (const [topic, entry] of Object.entries(registry)) {
    try {
      if (!(await canStreamTopic(req, topic, entry.route))) continue;
    } catch {
      continue;
    }
    topics[topic] = {
      guideSteps: entry.guideSteps ?? [],
      captions: Boolean(entry.captionsKey),
      screenshot: Boolean(entry.screenshotKey),
      sourceSha: entry.sourceSha ?? null,
      publishedAt: entry.publishedAt ?? null,
      durationSeconds: entry.durationSeconds ?? null,
      route: entry.route ?? null,
    };
  }
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("Vary", "Cookie");
  res.json({ provider: process.env.TRAINING_MEDIA_PROVIDER === "vercel" ? "vercel" : "static", topics });
}

export function registerTrainingMediaRoutes(app: Express): void {
  app.get("/api/training/media", requireAuth, (req, res) => {
    void listPublished(req, res);
  });
  app.get("/api/training/media/:topic", requireAuth, (req, res) => {
    void streamMedia(req, res, "video");
  });
  app.get("/api/training/media/:topic/captions", requireAuth, (req, res) => {
    void streamMedia(req, res, "captions");
  });
  app.get("/api/training/media/:topic/screenshot", requireAuth, (req, res) => {
    void streamMedia(req, res, "screenshot");
  });
}
