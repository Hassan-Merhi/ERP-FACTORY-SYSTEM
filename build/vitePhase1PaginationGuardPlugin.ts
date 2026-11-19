import type { Plugin } from "vite";
import { phase1PaginationPlugin as createLegacyPhase1PaginationPlugin } from "./vitePhase1PaginationPlugin.ts";
import { readModuleFamilySource } from "./moduleFamilySource.ts";

const DAYBOOK_SUFFIX = "/client/src/pages/Daybook.tsx";
const DAYBOOK_TABLE_SUFFIX = "/client/src/pages/daybook/DaybookTable.tsx";
const ACCOUNTS_MODEL_SUFFIX = "/client/src/pages/accountslegacy/useAccountsLegacyModel.ts";

/**
 * The Daybook table's bounded-window rendering and the Accounts statement's
 * continuous loading used to be applied by the legacy transform at build time.
 * Both are now committed to the source tree; the markers below identify that
 * source so the old rewrite is not applied a second time.
 */
function daybookTableWindowingIsAlreadyIntegrated(source: string): boolean {
  return source.includes("useBoundedTableRows({") && source.includes("daybookDesktopWindow");
}

function accountsStatementPaginationIsAlreadyIntegrated(source: string): boolean {
  return source.includes('"continuous-pages"') && source.includes("fetchAccountStatementChunk");
}

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
      // Split modules keep part of their source in extracted siblings, so the
      // integration checks read the whole module family.
      if (
        normalizedId.endsWith(DAYBOOK_SUFFIX) &&
        daybookPaginationIsAlreadyIntegrated(readModuleFamilySource(normalizedId, source))
      ) {
        return null;
      }
      if (
        normalizedId.endsWith(DAYBOOK_TABLE_SUFFIX) &&
        daybookTableWindowingIsAlreadyIntegrated(readModuleFamilySource(normalizedId, source))
      ) {
        return null;
      }
      if (
        normalizedId.endsWith(ACCOUNTS_MODEL_SUFFIX) &&
        accountsStatementPaginationIsAlreadyIntegrated(readModuleFamilySource(normalizedId, source))
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
