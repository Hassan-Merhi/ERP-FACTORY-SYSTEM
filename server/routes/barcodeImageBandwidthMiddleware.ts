import type { Express } from "express";
import { requireAuth } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";

type BarcodeImage = {
  contentType: string;
  body: string | Buffer;
  profile: "barcode-svg" | "barcode-png";
};

const MAX_BARCODE_CACHE_ENTRIES = 512;
const barcodeImageCache = new Map<string, BarcodeImage>();
const BWIP_MODULE_NAME: string = "bwip-js";

/** Subset of the bwip-js API this service uses (the package ships no usable declarations). */
interface BwipJsRenderer {
  toSVG(options: Record<string, unknown>): string;
  toBuffer(options: Record<string, unknown>): Promise<Buffer>;
}

let bwipjsPromise: Promise<BwipJsRenderer> | null = null;

function getBwipjs() {
  if (!bwipjsPromise) {
    // Keep this as a runtime-resolved module name. The package ships without a
    // declaration surface compatible with this project's TypeScript settings,
    // while the renderer itself is an existing production dependency.
    bwipjsPromise = import(BWIP_MODULE_NAME);
  }
  return bwipjsPromise;
}

function rememberBarcode(key: string, image: BarcodeImage): BarcodeImage {
  barcodeImageCache.delete(key);
  barcodeImageCache.set(key, image);
  while (barcodeImageCache.size > MAX_BARCODE_CACHE_ENTRIES) {
    const oldest = barcodeImageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    barcodeImageCache.delete(oldest);
  }
  return image;
}

function cachedBarcode(key: string): BarcodeImage | undefined {
  const image = barcodeImageCache.get(key);
  if (!image) return undefined;
  barcodeImageCache.delete(key);
  barcodeImageCache.set(key, image);
  return image;
}

function sendBarcode(req: import("express").Request, res: import("express").Response, image: BarcodeImage) {
  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Vary", "Accept");
  res.setHeader("X-ERP-Payload-Profile", image.profile);
  if (req.method === "HEAD") return res.status(200).end();
  return res.send(image.body);
}

/**
 * Bandwidth Phase 2 barcode image negotiation.
 *
 * Label/preview <img> requests advertise image/svg+xml support, so they receive
 * a compact vector Code 128 image instead of the old scale-14 raster PNG. A
 * generic direct fetch still receives PNG for backwards compatibility, and
 * callers can force either representation with ?format=svg|png.
 *
 * Barcode content is immutable for a given URL. Browser caching is therefore
 * extended to one year, and a bounded process-local LRU avoids repeatedly
 * rendering the same label during reprints/previews.
 */
export function registerBarcodeImageBandwidthMiddleware(app: Express): void {
  app.use("/api/barcode/:code", requireAuth, async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    try {
      const code = decodeURIComponent(String(req.params.code || "")).trim();
      if (!code) return res.status(400).json({ message: "Barcode code is required" });
      if (code.length > 128) return res.status(400).json({ message: "Barcode code is too long" });

      const requestedFormat = typeof req.query.format === "string" ? req.query.format.toLowerCase() : "";
      if (requestedFormat && requestedFormat !== "svg" && requestedFormat !== "png") {
        return res.status(400).json({ message: "format must be svg or png" });
      }

      const accept = String(req.headers.accept || "").toLowerCase();
      const useSvg = requestedFormat === "svg" || (requestedFormat !== "png" && accept.includes("image/svg+xml"));
      const format = useSvg ? "svg" : "png";
      const cacheKey = `${format}:${code}`;
      const cached = cachedBarcode(cacheKey);
      if (cached) return sendBarcode(req, res, cached);

      const bwipjs = await getBwipjs();
      let image: BarcodeImage;

      if (useSvg) {
        const svg = bwipjs.toSVG({
          bcid: "code128",
          text: code,
          scale: 3,
          height: 10,
          includetext: false,
          textxalign: "center",
          barcolor: "000000",
        });
        image = rememberBarcode(cacheKey, {
          contentType: "image/svg+xml; charset=utf-8",
          body: svg,
          profile: "barcode-svg",
        });
      } else {
        const png = await bwipjs.toBuffer({
          bcid: "code128",
          text: code,
          scale: 14,
          height: 40,
          includetext: false,
          textxalign: "center",
          barcolor: "000000",
        });
        image = rememberBarcode(cacheKey, {
          contentType: "image/png",
          body: png,
          profile: "barcode-png",
        });
      }

      return sendBarcode(req, res, image);
    } catch (error: unknown) {
      logger.error("Error generating bandwidth-optimized barcode image:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Load the renderer after startup without blocking route registration.
  void getBwipjs().catch(() => undefined);
}
