/**
 * Shared state and helpers for the factoryShippingContainerRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryShippingContainerRoutes.ts.
 */
import multer from "multer";
import http from "http";

export function getCompanyId(req: import("express").Request): number | null {
  return req.session.factoryCompanyId || req.session.currentCompanyId || null;
}

export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const scrUploadBase = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"));
    }
  },
});

export function scrUpload(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  scrUploadBase.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
}

export function safeDownloadName(name: string | null | undefined): string {
  if (!name) return "download";
  const safe = name
    .replace(/[^\x20-\x7E]/g, "") // strip non-ASCII (prevents ERR_INVALID_CHAR in headers)
    .replace(/[\r\n]+/g, "")
    .replace(/"/g, "")
    .replace(/;/g, "")
    .trim();
  return safe || "download";
}

/** Internal HTTP fetch — reuses session cookie so requireAuth passes.
 *  Uses process.env.PORT (reliable in production) rather than req.socket.localPort
 *  which is unreliable behind reverse proxies.
 */
export function fetchInternalBuffer(req: import("express").Request, urlPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      // Always use the app's own bind port. process.env.PORT is set by Replit/production.
      // req.socket.localPort is unreliable behind TLS-terminating reverse proxies.
      const appPort = Number(process.env.PORT) || 5000;
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: appPort,
        path: urlPath,
        method: "GET",
        headers: { cookie: req.headers.cookie || "" },
      };
      const chunks: Buffer[] = [];
      const r = http.request(options, (res2) => {
        if ((res2.statusCode ?? 0) >= 400) {
          res2.resume(); // drain so connection is released
          resolve(null);
          return;
        }
        res2.on("data", (d: Buffer) => chunks.push(d));
        res2.on("end", () => resolve(Buffer.concat(chunks)));
        res2.on("error", () => resolve(null));
      });
      r.on("error", () => resolve(null));
      r.setTimeout(45000, () => {
        r.destroy();
        resolve(null);
      });
      r.end();
    } catch {
      resolve(null);
    }
  });
}
