// Extracted from ./SpSetupPanel.tsx
import { confirmAction, promptText } from "@/components/ConfirmHost";
import { CheckCircle2, AlertCircle } from "lucide-react";

export interface GoldenCoastRoleStatus {
  role: string;
  expectedName: string;
  expectedAccountType: string;
  status: "ok" | "missing" | "needs_repair";
  code: string | null;
  name: string | null;
  accountType: string | null;
  openingBalanceTargetUsd: string | null;
  ownershipSharePct: string | null;
  issues: string[];
  warnings: string[];
}

interface GoldenCoastIntercompanyAccountStatus {
  role: string;
  companyId: number;
  subType: string;
  expectedName: string;
  status: "ok" | "missing" | "needs_repair" | "ambiguous";
  accountId: number | null;
  name: string | null;
  accountType: string | null;
  issues: string[];
}

interface GoldenCoastPhase13Status {
  isConfigured: boolean;
  parentCompanyId: number;
  parentCompanyName: string;
  parentAuthorized: boolean;
  goldenCoastAccount: GoldenCoastIntercompanyAccountStatus;
  hadiAccount: GoldenCoastIntercompanyAccountStatus | null;
  blockers: string[];
}

export interface GoldenCoastSetupStatus {
  isConfigured: boolean;
  requiredRoleCount: number;
  configuredRoleCount: number;
  roles: GoldenCoastRoleStatus[];
  phase13?: GoldenCoastPhase13Status;
}

interface SpAccount {
  id: number;
  code?: string;
  name?: string;
  isHidden?: boolean;
  accountType?: string;
}

export interface SpSetupStatus {
  requiredAccountCount?: number;
  spAccounts?: SpAccount[];
  supplierVoucherLinkGapCount?: number;
  isConfigured?: boolean;
  locations?: { name: string }[];
  bankAccounts?: unknown[];
  goldenCoast?: GoldenCoastSetupStatus;
}

export interface SetupConfirmationPayload {
  confirmation: "CHANGE SP SETUP";
  reason: string;
  idempotencyKey: string;
  clientRequestId: string;
  targetCompanyId?: number;
}

function createFreshIdempotencyKey(scope: string): string {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
  return uuid ? `${scope}:${uuid}` : `${scope}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export async function requestSetupConfirmation(
  actionLabel: string,
  targetCompanyId?: number
): Promise<SetupConfirmationPayload | null> {
  const confirmed = await confirmAction({
    title: actionLabel,
    description: "Type exactly: CHANGE SP SETUP",
    requirePhrase: "CHANGE SP SETUP",
    tone: "warning",
  });
  if (!confirmed) return null;

  const reason = await promptText({
    title: "Reason for this setup change",
    label: "Enter a meaningful reason for this setup change (at least 5 characters):",
    minLength: 5,
  });
  if (reason == null || reason.length < 5) return null;

  const idempotencyKey = createFreshIdempotencyKey("sp-setup");
  return {
    confirmation: "CHANGE SP SETUP",
    reason,
    idempotencyKey,
    clientRequestId: idempotencyKey,
    ...(targetCompanyId && targetCompanyId > 0 ? { targetCompanyId } : {}),
  };
}

export function IntercompanyReadinessRow({ account }: { account: GoldenCoastIntercompanyAccountStatus }) {
  const ok = account.status === "ok";
  return (
    <div className="flex items-start justify-between gap-3 text-sm py-1.5 border-b border-border/40 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          )}
          <span className="font-medium">{account.name ?? account.expectedName}</span>
          <span className="font-mono text-xs text-muted-foreground">{account.subType}</span>
        </div>
        {account.issues?.length > 0 && <p className="text-xs text-amber-600 mt-0.5">{account.issues.join(" · ")}</p>}
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{account.accountType ?? "Intercompany"}</span>
    </div>
  );
}
