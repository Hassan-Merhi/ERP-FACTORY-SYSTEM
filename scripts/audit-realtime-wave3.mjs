import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const phase5Targets = [
  {
    path: "client/src/components/erpworkerdetail/useERPWorkerDetailModel.tsx",
    requiredFreshness: [/staleTime:\s*15000/],
  },
  {
    path: "client/src/pages/PurchaseOrderEdit.tsx",
    requiredFreshness: [/staleTime:\s*15000/],
  },
  {
    path: "client/src/pages/vouchers/useVoucherQueries.ts",
    requiredFreshness: [],
  },
  {
    path: "client/src/pages/factory/factoryworkers/useFactoryWorkersModel.tsx",
    requiredFreshness: [/staleTime:\s*15000/],
  },
  {
    path: "client/src/pages/factory/factorystockallocationv5/useFactoryStockAllocationV5Model.tsx",
    requiredFreshness: [/staleTime:\s*15000/, /staleTime:\s*2\s*\*\s*60\s*\*\s*1000/],
  },
  {
    path: "client/src/pages/factory/FactoryAdvancesTab.tsx",
    requiredFreshness: [/staleTime:\s*60000/, /staleTime:\s*5\s*\*\s*60000/],
  },
  {
    path: "client/src/pages/factory/factoryadvancestab/advances/useAdvancesModel.tsx",
    requiredFreshness: [/staleTime:\s*15000/],
  },
  {
    path: "client/src/pages/factory/factoryadvancestab/components/RepaymentsView.tsx",
    requiredFreshness: [/staleTime:\s*60_000/],
  },
  {
    path: "client/src/pages/factory/factoryadvancestab/components/DeductionsView.tsx",
    requiredFreshness: [/staleTime:\s*60_000/],
  },
  {
    path: "client/src/pages/factory/FactoryDispatchBatchDetail.tsx",
    requiredFreshness: [/staleTime:\s*15000/],
  },
];

export function auditRealtimeWave3(root = repoRoot) {
  const errors = [];
  const readAtRoot = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

  for (const target of phase5Targets) {
    const source = readAtRoot(target.path);
    if (/staleTime\s*:\s*0(?![\d_])/.test(source)) {
      errors.push(`${target.path}: staleTime: 0 reintroduced`);
    }
    for (const required of target.requiredFreshness) {
      if (!required.test(source)) {
        errors.push(`${target.path}: expected reviewed non-zero freshness policy is missing (${required})`);
      }
    }
  }

  const netPositionPath = "server/helpers/calculateNetPositionAsOf.ts";
  const netPosition = readAtRoot(netPositionPath);
  const requiredSqlContracts = [
    /db\.execute<RawQueryRow<LedgerBalanceRow>>\(sql`/,
    /db\.execute<RawQueryRow<PartyBalanceRow>>\(sql`/,
    /SUM\(CAST\(ve\.debit_amount\s+AS numeric\)\) AS total_debit/,
    /SUM\(CAST\(ve\.credit_amount\s+AS numeric\)\) AS total_credit/,
    /la\.company_id\s+=\s+\$\{companyId\}/,
    /v\.company_id\s+=\s+\$\{companyId\}/,
    /v\.optional\s+=\s+false/,
    /v\.deleted_at\s+IS NULL/,
    /v\.voucher_date\s+<=\s+\$\{toDate\}/,
    /GROUP BY ve\.ledger_account_id/,
    /GROUP BY ve\.supplier_id, ve\.employee_id/,
    /const accountBalances = new Map<number, \{ debit: number; credit: number \}>\(\)/,
    /const supplierBalances = new Map<number, \{ debit: number; credit: number \}>\(\)/,
    /const employeeBalances = new Map<number, \{ debit: number; credit: number \}>\(\)/,
    /classifyNetPositionAccounts\(accountsForClassify, accountBalances/,
    /classifyEquityAccounts\(companyAccounts, accountBalances\)/,
  ];

  for (const required of requiredSqlContracts) {
    if (!required.test(netPosition)) {
      errors.push(`${netPositionPath}: SQL aggregation contract is missing (${required})`);
    }
  }

  const forbiddenLegacyPatterns = [
    /getVoucherEntries\(/,
    /getAllVoucherEntries\(/,
    /const\s+allEntries\s*=.*voucher/i,
  ];
  for (const forbidden of forbiddenLegacyPatterns) {
    if (forbidden.test(netPosition)) {
      errors.push(`${netPositionPath}: legacy full-entry Node aggregation returned (${forbidden})`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    phase5Targets: phase5Targets.map((target) => target.path),
    phase6Target: netPositionPath,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditRealtimeWave3();
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Wave 3 audit passed: ${result.phase5Targets.length} query surfaces + SQL net-position aggregation.`);
  }
}
