import type { Plugin } from "vite";
import { phase1PaginationPlugin as createLegacyPhase1PaginationPlugin } from "./vitePhase1PaginationPlugin.ts";

const DAYBOOK_SUFFIX = "/client/src/pages/Daybook.tsx";

function daybookPaginationIsAlreadyIntegrated(source: string): boolean {
  return (
    source.includes('usePaginatedDaybookVouchers') &&
    source.includes('from "./daybook/usePaginatedDaybookVouchers"') &&
    source.includes('<PaginationBar')
  );
}

/**
 * Keeps the historical Phase 1 build transforms for files that still need them,
 * but avoids applying the old Daybook source rewrite after pagination has been
 * committed to the real source tree. This makes production builds idempotent.
 */
export function phase1PaginationPlugin(): Plugin {
  const legacyPlugin = createLegacyPhase1PaginationPlugin();
  const legacyTransform = (legacyPlugin.transform);

  return {
    ...legacyPlugin,
    name: "erp-phase1-pagination-guarded",
    transform(source, id, ...args) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];
      if (
        normalizedId.endsWith(DAYBOOK_SUFFIX) &&
        daybookPaginationIsAlreadyIntegrated(source)
      ) {
        return null;
      }

      if (typeof legacyTransform === "function") {
        return legacyTransform.call(this, source, id, ...args);
      }
      if (legacyTransform && typeof legacyTransform.handler === "function") {
        return legacyTransform.handler.call(this, source, id, ...args);
      }
      return null;
    },
  };
}
