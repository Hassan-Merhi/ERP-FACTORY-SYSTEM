import type { RequestHandler } from "express";
import helmet, { type HelmetOptions } from "helmet";

import { CSP_REPORT_PATH } from "./contentSecurityPolicy";

/**
 * Build the HTTP security-header policy for the ERP shell.
 *
 * Production deliberately keeps JavaScript nonce-free and inline-free: every
 * executable script is served from our own origin. Development keeps the two
 * Vite allowances (`unsafe-inline` and `unsafe-eval`) because the React refresh
 * preamble is injected into transformed HTML and source maps use eval-like
 * constructs. Those allowances never reach NODE_ENV=production.
 *
 * Inline styles remain allowed because the existing React UI uses style
 * attributes extensively. This does not weaken script execution because
 * script-src and script-src-attr remain independently locked down. Blob-backed
 * frames remain allowed for authenticated stored-file/PDF previews, and
 * blob:/data: media for generated audio and video.
 *
 * This is the only Content-Security-Policy the server sends, and it is
 * enforced. Browsers report violations to /api/csp-report
 * (server/security/contentSecurityPolicy.ts), so a blocked resource shows up
 * in the logs instead of failing silently.
 */
export function buildSecurityHeaderOptions(nodeEnv = process.env.NODE_ENV): HelmetOptions {
  const isProduction = nodeEnv === "production";

  return {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'", "blob:"],
        formAction: ["'self'"],
        scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: isProduction ? ["'self'", "https:", "wss:"] : ["'self'", "http:", "https:", "ws:", "wss:"],
        workerSrc: ["'self'", "blob:"],
        mediaSrc: ["'self'", "blob:", "data:"],
        manifestSrc: ["'self'"],
        reportUri: [CSP_REPORT_PATH],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  };
}

export function securityHeadersMiddleware(nodeEnv = process.env.NODE_ENV): RequestHandler {
  return helmet(buildSecurityHeaderOptions(nodeEnv));
}
