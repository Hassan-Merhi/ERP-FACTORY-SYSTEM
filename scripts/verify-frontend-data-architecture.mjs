import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];

const architecture = read("client/src/lib/frontendDataArchitecture.ts");
for (const required of [
  "canonicalApiUrl",
  "canonicalSetValues",
  "companyDataKey",
  "paginatedCompanyDataKey",
  "queryMatchesApiFamily",
  "queryMatchesCompanyApiFamily",
  "invalidateApiFamily",
  "invalidateCompanyApiFamily",
  "removeApiFamily",
  "removeCompanyApiFamily",
  "unwrapList",
  "unwrapPage",
  "frontendQueryPolicies",
  'refetchType ?? "active"',
]) {
  if (!architecture.includes(required)) failures.push(`frontendDataArchitecture.ts missing ${required}`);
}

for (const forbidden of ["startsWith(family)", "JSON.stringify(params)"]) {
  if (architecture.includes(forbidden)) failures.push(`frontendDataArchitecture.ts contains unsafe ${forbidden}`);
}

const keys = read("client/src/lib/queryKeys.ts");
for (const required of [
  "companyKeys",
  "canonicalApiUrl",
  "companyDataKey",
  "autoTransferConfig",
  "voucherSearch",
  "stockItemKeys",
  "page:",
]) {
  if (!keys.includes(required)) failures.push(`queryKeys.ts missing ${required}`);
}

const gitHook = read("client/src/pages/git-containers/usePaginatedGITContainers.ts");
for (const required of [
  "canonicalApiUrl",
  "canonicalSetValues",
  "companyDataKey(",
  "useInfiniteQuery",
  "companyIdentity",
  "loadContainerDetail = async (id: number, companyId: number)",
  "frontendQueryPolicies.operational",
]) {
  if (!gitHook.includes(required)) failures.push(`usePaginatedGITContainers missing ${required}`);
}

const daybookHook = read("client/src/pages/daybook/usePaginatedDaybookVouchers.ts");
for (const required of [
  "canonicalApiUrl",
  "paginatedCompanyDataKey",
  "frontendQueryPolicies.operational",
  "loadAllVouchers",
]) {
  if (!daybookHook.includes(required)) failures.push(`usePaginatedDaybookVouchers missing ${required}`);
}

const daybook = read("client/src/pages/Daybook.tsx");
for (const required of [
  "companyDataKey(offloadsUrl",
  "invalidateCompanyApiFamily",
  "daybook-view-entries",
  "daybook-expanded-entries",
  "daybook-transfer-revisions",
  "daybook-edit-entries",
  "frontendQueryPolicies.reference",
]) {
  if (!daybook.includes(required)) failures.push(`Daybook integration missing ${required}`);
}

const drawer = read("client/src/pages/git-containers/ContainerDrawer.tsx");
for (const required of [
  "companyDataKey(eventsQueryKey",
  "container-tracking-events",
  "invalidateApiFamily",
]) {
  if (!drawer.includes(required)) failures.push(`ContainerDrawer integration missing ${required}`);
}

for (const test of [
  "tests/ui/frontend-data-architecture.test.ts",
  "tests/ui/queryKeys.test.ts",
]) {
  if (!fs.existsSync(path.join(root, test))) failures.push(`missing focused test ${test}`);
}

const docs = read("docs/archive/engineering/phase8-frontend-data-architecture.md").toLowerCase();
for (const phrase of [
  "canonical request urls",
  "company-scoped cache identity",
  "paginated screen integration",
  "exact endpoint-family invalidation",
  "response-shape normalization",
  "query policies",
  "export compatibility",
  "deferred verification",
  "merge order",
]) {
  if (!docs.includes(phrase)) failures.push(`phase8 documentation missing ${phrase}`);
}

if (failures.length) {
  console.error("Phase 8 frontend data architecture verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Phase 8 frontend data architecture contracts verified.");
