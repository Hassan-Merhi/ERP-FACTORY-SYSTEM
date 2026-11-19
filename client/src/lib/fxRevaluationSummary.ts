/**
 * What the automatic FX revaluation did after a rate save
 * (POST /api/exchange-rates returns it as `fxRevaluation`), in one sentence
 * for the save toast.
 */
import { queryClient } from "./queryClient";

type FxRevaluationOutcome = {
  status?: "posted" | "nothing_to_post" | "skipped" | "failed";
  reason?: string;
  voucherNumber?: string;
  netGainUsd?: string;
  lines?: unknown[];
  unresolvedAccounts?: string[];
};

export async function readFxRevaluation(response: Response): Promise<FxRevaluationOutcome | null> {
  try {
    const body = (await response.clone().json()) as { fxRevaluation?: FxRevaluationOutcome };
    return body?.fxRevaluation ?? null;
  } catch {
    return null;
  }
}

export function fxRevaluationSummary(outcome: FxRevaluationOutcome | null): {
  description: string;
  problem: boolean;
} {
  if (!outcome) return { description: "Rate-dependent USD views are refreshing.", problem: false };
  const unresolved = outcome.unresolvedAccounts ?? [];
  const more = unresolved.length > 5 ? ` and ${unresolved.length - 5} more` : "";
  const unresolvedNote = unresolved.length
    ? ` Not revalued (original currency unresolved): ${unresolved.slice(0, 5).join(", ")}${more}.`
    : "";
  if (outcome.status === "posted") {
    const net = Number(outcome.netGainUsd ?? 0);
    const amount = Math.abs(net).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const result = net > 0 ? `FX gain $${amount}` : net < 0 ? `FX loss $${amount}` : "no net gain or loss";
    const count = outcome.lines?.length ?? 0;
    return {
      description: `FX revaluation ${outcome.voucherNumber ?? ""} posted for ${count} account(s): ${result}.${unresolvedNote}`,
      problem: unresolved.length > 0,
    };
  }
  if (outcome.status === "nothing_to_post") {
    return {
      description: `Balances are already at this rate; no FX revaluation was needed.${unresolvedNote}`,
      problem: unresolved.length > 0,
    };
  }
  return {
    description: `The rate was saved, but the FX revaluation was not posted: ${outcome.reason || "unknown reason"}.${unresolvedNote}`,
    problem: true,
  };
}

const POSTED_JOURNAL_QUERY_FAMILIES = [
  "/api/vouchers",
  "/api/daybook",
  "/api/accounts",
  "/api/ledger-accounts",
  "/api/bank-accounts",
  "/api/customers",
  "/api/stats",
];

/** A posted revaluation is a new Journal: refresh the voucher and ledger lists too. */
export function refreshAfterFxRevaluation(outcome: FxRevaluationOutcome | null): void {
  if (outcome?.status !== "posted") return;
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const key = String(query.queryKey[0] ?? "");
      return POSTED_JOURNAL_QUERY_FAMILIES.some((family) => key.startsWith(family));
    },
  });
}
