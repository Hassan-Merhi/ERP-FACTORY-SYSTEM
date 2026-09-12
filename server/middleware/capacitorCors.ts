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

export const capacitorCors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && CAPACITOR_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-CSRF-Token,X-Client-Date,X-Requested-With"
    );
    res.setHeader("Access-Control-Max-Age", "86400"); // 24h preflight cache
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
  }
  next();
};
