#!/usr/bin/env node

/**
 * Program 6B static regression guard.
 *
 * Protects accounting invariants while daybook, account selectors, and report
 * contracts are bounded. It does not execute production data or mutate the DB.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const daybookRoute = read("server/routes/factory/factoryDaybookPaginationRoutes.ts");
const accountsWrapper = read("client/src/pages/Accounts.tsx");
// AccountsLegacy.tsx keeps its view; data wiring moved to its model hook.
const accountsPage = [
  read("client/src/pages/AccountsLegacy.tsx"),
  read("client/src/pages/accountslegacy/useAccountsLegacyModel.ts"),
].join("\n");
const ledgerWrapper = read("server/routes/ledgerRoutes.ts");
// ledgerRoutesLegacy.ts was split into server/routes/ledger/ (Phase 3 route monoliths).
const ledgerRoutes = fs
  .readdirSync(path.join(root, "server/routes/ledger"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => read(`server/routes/ledger/${file}`))
  .join("\n");
const ledgerOptions = read("server/services/ledgerAccountOptionsService.ts");
const netProfitRoute = read("server/routes/stats/statsNetProfitRoutes.ts");

assert(daybookRoute.includes("MAX_PAGE_SIZE = 250"), "Factory Daybook must retain a bounded maximum page size.");
assert(daybookRoute.includes("COUNT(*)::int FROM filtered"), "Factory Daybook total must be calculated from the complete filtered result.");
assert(daybookRoute.includes("hasNextPage"), "Factory Daybook pagination metadata is missing.");
assert(daybookRoute.includes("ORDER BY sort_date"), "Factory Daybook must retain deterministic server ordering.");

assert(accountsPage.includes('queryKey: ["/api/accounts/all"'), "Accounts screen must retain the balance-aware accounts endpoint.");
assert(accountsPage.includes("accountsResponse?.accounts"), "Accounts screen must unwrap the balance-aware response contract.");
assert(accountsPage.includes("rawTransactionData.preNetBalance"), "Account statements must preserve pre-period balance semantics.");
assert(accountsPage.includes("broughtForwardBalance"), "Account statements must preserve brought-forward balance calculation.");
assert(accountsWrapper.includes("/api/ledger-accounts/parent-groups"), "Accounts Parent Group selector must use the field-limited endpoint.");

assert(ledgerWrapper.includes('app.get("/api/ledger-accounts/parent-groups"'), "Parent-group endpoint is not registered before legacy ledger routes.");
assert(ledgerWrapper.includes("registerLegacyLedgerRoutes(app)"), "Legacy ledger selector compatibility must be preserved.");
assert(ledgerOptions.includes('eq(ledgerAccounts.subType, "Group")'), "Parent-group endpoint must include explicitly tagged groups.");
assert(ledgerOptions.includes("inArray(ledgerAccounts.id, legacyParentIds)"), "Parent-group endpoint must retain legacy parent accounts.");
assert(ledgerOptions.includes(".select({"), "Parent-group endpoint must use an explicit field-limited select.");
assert(ledgerRoutes.includes("eq(ledgerAccounts.accountType, accountType.trim())"), "Ledger account type filtering must remain server-side.");
assert(ledgerRoutes.includes("punctuationInsensitiveSearch(ledgerAccounts.name, term)"), "Ledger account search must remain server-side.");

assert(netProfitRoute.includes('app.get("/api/stats/net-profit"'), "Net-profit summary endpoint must remain registered.");
assert(netProfitRoute.includes("_getCached(_cacheKey)"), "Net-profit summary must retain its short company/date keyed cache.");
assert(netProfitRoute.includes("Promise.all(["), "Net-profit independent reads must remain parallelized.");
assert(!netProfitRoute.includes("LIMIT ") && !netProfitRoute.includes("OFFSET "), "Net-profit is a summary contract and must not be page-dependent.");

if (failures.length > 0) {
  console.error("Program 6B financial pagination verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Program 6B financial pagination invariants verified.");
