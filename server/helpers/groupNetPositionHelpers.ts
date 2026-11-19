// Extracted from ./groupNetPosition.ts
import { round2 } from "../netPositionHelper";
import type { NetPositionLineItem, NetPositionSnapshot } from "./calculateNetPositionAsOf";
import { type IntercompanyAccount } from "./groupIntercompany";
import {
  asRecord,
  runNetProfitPipeline,
  type NetProfitRequest,
  type NetProfitResponse,
} from "./runWithGroupCompanyScope";

function accountValue(account: unknown): number {
  return round2(Number(asRecord(account).value ?? 0) || 0);
}

function toLineItem(account: unknown, side: "forUs" | "onUs"): NetPositionLineItem {
  const row = asRecord(account);
  return {
    label: String(row.name ?? row.label ?? "Unnamed"),
    value: round2(Number(row.value ?? 0) || 0),
    category: String(row.category ?? "Other"),
    side,
  };
}

interface ErpNetPositionWithIntercompany extends NetPositionSnapshot {
  /** Signed values (What We Have positive) of the intercompany accounts removed from the lines, by id. */
  removedIntercompany: Map<number, number>;
}

export async function calculateErpNetPosition(
  companyId: number,
  asOfDate: string,
  useCurrentSnapshot: boolean,
  intercompanyIds: ReadonlySet<number>
): Promise<ErpNetPositionWithIntercompany> {
  let responseBody: unknown = null;
  let statusCode = 200;

  const req: NetProfitRequest = {
    method: "GET",
    path: "/api/stats/net-profit",
    session: { currentCompanyId: companyId },
    query: useCurrentSnapshot ? {} : { toDate: asOfDate },
  };
  const response: NetProfitResponse = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      responseBody = body;
      return response;
    },
  };

  await runNetProfitPipeline(req, response);
  const body = asRecord(responseBody);
  if (statusCode >= 400 || Object.keys(body).length === 0) {
    throw new Error(String(body.message ?? `ERP Net Position failed with status ${statusCode}`));
  }

  const forUs = asRecord(body.forUs);
  const onUs = asRecord(body.onUs);
  const rawForUsTotal = round2(Number(body.forUsTotal ?? forUs.total ?? 0) || 0);
  const rawOnUsTotal = round2(Number(body.onUsTotal ?? onUs.total ?? 0) || 0);
  const rawForUsAccounts = Array.isArray(forUs.accounts) ? forUs.accounts : [];
  const rawOnUsAccounts = Array.isArray(onUs.accounts) ? onUs.accounts : [];

  // Intercompany accounts are taken out of the company's lines by id and
  // eliminated in pairs at group level (owner decision 1); nothing is removed
  // by name or code.
  const isIntercompany = (account: unknown) => {
    const row = asRecord(account);
    const id = Number(row.id);
    return row.bankAccountId == null && Number.isInteger(id) && intercompanyIds.has(id);
  };
  const removedIntercompany = new Map<number, number>();
  for (const account of rawForUsAccounts.filter(isIntercompany)) {
    const id = Number(asRecord(account).id);
    removedIntercompany.set(id, round2((removedIntercompany.get(id) ?? 0) + accountValue(account)));
  }
  for (const account of rawOnUsAccounts.filter(isIntercompany)) {
    const id = Number(asRecord(account).id);
    removedIntercompany.set(id, round2((removedIntercompany.get(id) ?? 0) - accountValue(account)));
  }
  const excludedForUsTotal = round2(
    rawForUsAccounts.filter(isIntercompany).reduce((sum, account) => sum + accountValue(account), 0)
  );
  const excludedOnUsTotal = round2(
    rawOnUsAccounts.filter(isIntercompany).reduce((sum, account) => sum + accountValue(account), 0)
  );
  const forUsAccounts = rawForUsAccounts.filter((account) => !isIntercompany(account));
  const onUsAccounts = rawOnUsAccounts.filter((account) => !isIntercompany(account));
  const forUsTotal = round2(rawForUsTotal - excludedForUsTotal);
  const onUsTotal = round2(rawOnUsTotal - excludedOnUsTotal);
  const netPosition = round2(forUsTotal - onUsTotal);

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: netPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
    forUsLines: forUsAccounts.map((account) => toLineItem(account, "forUs")),
    onUsLines: onUsAccounts.map((account) => toLineItem(account, "onUs")),
    removedIntercompany,
  };
}

export interface IntercompanyValue extends IntercompanyAccount {
  /** Signed, What We Have positive. */
  value: number;
}
