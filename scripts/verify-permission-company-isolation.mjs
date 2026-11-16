import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];

const boundary = read("server/security/companyAccessBoundary.ts");
for (const required of [
  "getCompanyAccessContext",
  "assertCompanyAccess",
  "assertCompaniesAccess",
  "resolveAuthorizedCompanyId",
  "parsePositiveCompanyId",
  "req.session?.currentRole ?? req.user?.role",
  "CROSS_COMPANY_FORBIDDEN",
  "COMPANY_ACCESS_DENIED",
  "await assertCompanyAccess(context.userId, targetCompanyId)",
]) {
  if (!boundary.includes(required)) failures.push(`companyAccessBoundary missing ${required}`);
}

const transfer = read("server/routes/transfers/transferRequestContext.ts");
for (const required of ["getCompanyAccessContext", "assertCompaniesAccess", "assertCompanyAccess"]) {
  if (!transfer.includes(required)) failures.push(`transferRequestContext missing ${required}`);
}
if (transfer.includes("storage.getUserCompaniesWithRoles")) {
  failures.push("transferRequestContext still owns duplicate company-role lookup logic");
}

const exportRoute = read("server/routes/netPositionMonthlyExcelRoute.ts");
for (const required of [
  "requireNonPOS",
  "resolveAuthorizedCompanyId(req, req.query.companyId)",
  "sendCompanyAccessError",
]) {
  if (!exportRoute.includes(required)) failures.push(`netPositionMonthlyExcelRoute missing ${required}`);
}
if (exportRoute.includes("isAdminOrDev && requestedCompanyId")) {
  failures.push("net-position export still permits role-only cross-company override");
}

const gitHelpers = read("server/lib/gitHelpers.ts");
for (const required of [
  "getAccessibleCompanyIds as getMembershipCompanyIds",
  "isPrivilegedRole",
  "COMPANY_ACCESS_DENIED",
  "CROSS_COMPANY_FORBIDDEN",
]) {
  if (!gitHelpers.includes(required)) failures.push(`gitHelpers missing ${required}`);
}
for (const forbidden of ["userCompanyRoles", "Admin / Developer: all companies"]) {
  if (gitHelpers.includes(forbidden)) failures.push(`gitHelpers still contains role-only access marker ${forbidden}`);
}

const gitRoutes = read("server/routes/git/gitReportRoutes.ts");
for (const required of [
  "resolveGitCompanyScope",
  "code: scope.code",
  "req.session?.currentRole ??",
  "buildAgentsForCompany(scope.companyId)",
]) {
  if (!gitRoutes.includes(required)) failures.push(`gitReportRoutes missing ${required}`);
}

const voucherRoutes = read("server/routes/vouchers/voucherQueryRoutes.ts");
for (const required of [
  "assertActiveCompanyAccess(req)",
  "resolveAuthorizedCompanyId(req, companyId)",
  "getAccessibleCompanyIds(access.userId)",
  "inArray(containers.companyId, companyIds)",
  "sendCompanyAccessError(res, error)",
]) {
  if (!voucherRoutes.includes(required)) failures.push(`voucherQueryRoutes missing ${required}`);
}
if (voucherRoutes.includes("const companies = await storage.getAllCompanies()")) {
  failures.push("voucherQueryRoutes still loads every company for supplier cross-company reads");
}

const offloadRoutes = read("server/routes/offloadRoutes.ts");
for (const required of [
  "assertActiveCompanyAccess(req)",
  "offload.companyId !== access.activeCompanyId",
  "eq(vouchers.companyId, offload.companyId)",
  "COMPANY_ACCESS_DENIED",
]) {
  if (!offloadRoutes.includes(required)) failures.push(`offloadRoutes missing ${required}`);
}

const docs = read("docs/archive/engineering/phase7-permission-company-isolation-completion.md").toLowerCase();
for (const phrase of [
  "explicit company membership",
  "privileged cross-company access",
  "git containers and reports",
  "voucher and daybook boundary",
  "offload boundary",
  "database changes",
  "deferred verification",
  "merge order",
]) {
  if (!docs.includes(phrase)) failures.push(`Phase 7 documentation missing ${phrase}`);
}

if (!fs.existsSync(path.join(root, "tests/company-access-boundary-contract.test.ts"))) {
  failures.push("missing company access boundary contract test");
}

if (failures.length) {
  console.error("Phase 7 permission and company isolation verification failed:");
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}

console.log("Phase 7 permission and company isolation contracts verified.");
