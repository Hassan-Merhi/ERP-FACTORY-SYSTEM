/**
 * Capacitor / Mobile CORS middleware.
 *
 * Browser WebViews (iOS Capacitor, Android Capacitor, Ionic) send these origins
 * when calling the production API. They cannot be spoofed by web-based CSRF
 * attacks. We must echo the exact origin back (not "*") so that the browser
 * also honours Access-Control-Allow-Credentials: true. Extracted from
 * server/index.ts; behaviour is unchanged.
 */
import type { RequestHandler } from "express";

const CAPACITOR_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
]);

const DEFAULT_ALLOWED_HEADERS = "Content-Type,Authorization,X-CSRF-Token,X-Client-Date,X-Requested-With";

export const capacitorCors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && CAPACITOR_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    // Allow the headers the preflight asks for. A fixed list here fell behind
    // the client (it lacked X-Request-Id, which every request carries), and the
    // browser then refused every API call from the native apps. These origins
    // are already trusted with credentials and every method, so naming the
    // headers individually adds no protection.
    const requestedHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      typeof requestedHeaders === "string" && requestedHeaders.trim() ? requestedHeaders : DEFAULT_ALLOWED_HEADERS
    );
    res.append("Vary", "Origin, Access-Control-Request-Headers");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24h preflight cache
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
  }
  next();
};
