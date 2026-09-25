import type { Express } from "express";

import { broadcast } from "../wsServer";
import { classifyRealtimeWrite, shouldEmitWriteInvalidation } from "../../shared/realtimeInvalidation";
import { resolveActiveCompanyId } from "./helpers/resolveActiveCompanyId";

/**
 * After every successful write, broadcast a tenant-scoped realtime invalidation
 * so other tabs/devices refetch. The write/no-write decision and the topics are
 * owned by the shared classifier; this middleware only wires it to responses.
 */
export function registerWriteInvalidationSignal(app: Express): void {
  app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    if (shouldEmitWriteInvalidation(req.method, url)) {
      const companyId = resolveActiveCompanyId(req);
      const invalidation = classifyRealtimeWrite(url, req.body);
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const requestPath = url.split("?", 1)[0];
          // A single loading-bale scan returns a compact patch that the calling
          // tab applies to its order/capacity cache immediately. Do not make
          // that exact tab download the same Factory state again via its WS
          // echo; every other tab/device still receives the invalidation.
          const suppressOriginEcho =
            req.method === "POST" && /^\/api\/factory\/customer-orders\/\d+\/bales$/.test(requestPath);
          const rawRealtimeClientId = req.headers["x-realtime-client-id"];
          const realtimeClientId =
            suppressOriginEcho && typeof rawRealtimeClientId === "string"
              ? rawRealtimeClientId.trim().slice(0, 128)
              : null;
          broadcast(
            { type: "invalidate", ...invalidation },
            { companyId, excludeRealtimeClientId: realtimeClientId || null }
          );
        }
      });
    }
    next();
  });
}
