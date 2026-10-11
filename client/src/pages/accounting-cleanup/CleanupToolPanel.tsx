import { useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, Loader2, Play } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequestPrivileged } from "@/lib/queryClient";

import { collectVouchers, fieldLabel, PlanFigures, VoucherLinks, type PlanRecord } from "./cleanupPlanView";
import { describeRefusal, NOTHING_TO_DO_CODES, type Refusal } from "./cleanupRefusals";
import type { CleanupTool, ToolOptions } from "./cleanupTypes";

export type ToolStatus = "notStarted" | "previewed" | "blocked" | "nothingToDo" | "applied";

export const STATUS_LABEL: Record<ToolStatus, string> = {
  notStarted: "Not started",
  previewed: "Previewed",
  blocked: "Blocked",
  nothingToDo: "Nothing to do",
  applied: "Applied",
};

const STATUS_VARIANT: Record<ToolStatus, "outline" | "secondary" | "destructive" | "default"> = {
  notStarted: "outline",
  previewed: "secondary",
  blocked: "destructive",
  nothingToDo: "outline",
  applied: "default",
};

export function roleAllowed(role: string, roles: readonly string[]): boolean {
  return role === "Developer" || roles.includes(role);
}

/** A plan's blocker codes; a readiness blocker is an object with its own message. */
function serverBlockers(plan: PlanRecord): string[] {
  if (!Array.isArray(plan.blockers)) return [];
  return plan.blockers.map((entry) => {
    if (entry && typeof entry === "object") {
      const { code, message } = entry as { code?: unknown; message?: unknown };
      return typeof message === "string" && message ? message : String(code ?? "");
    }
    return String(entry);
  });
}

/** The plan's own blockers (the server's codes) that stop an apply, and the page's. */
export function planBlockers(tool: CleanupTool, plan: PlanRecord, options: ToolOptions): string[] {
  const codes = [
    ...serverBlockers(plan).filter((code) => !NOTHING_TO_DO_CODES.has(code) && code !== "ALREADY_APPLIED"),
    ...(tool.clientBlockers?.(plan, options) ?? []),
  ];
  return Array.from(new Set(codes));
}

export function planIsEmpty(tool: CleanupTool, plan: PlanRecord): boolean {
  return serverBlockers(plan).some((code) => NOTHING_TO_DO_CODES.has(code)) || (tool.isEmpty?.(plan) ?? false);
}

function blockerLabel(tool: CleanupTool, code: string): string {
  const known = tool.blockerText?.[code] ?? GENERIC_BLOCKER_TEXT[code];
  if (known) return known;
  return /^[A-Z0-9_]+$/.test(code) ? fieldLabel(code) : code;
}

export function toolStatus(
  tool: CleanupTool,
  plan: PlanRecord | null,
  options: ToolOptions,
  appliedNow: boolean
): ToolStatus {
  if (appliedNow) return "applied";
  if (!plan) return "notStarted";
  if (tool.isApplied?.(plan) || serverBlockers(plan).includes("ALREADY_APPLIED")) return "applied";
  if (planIsEmpty(tool, plan)) return "nothingToDo";
  if (planBlockers(tool, plan, options).length > 0) return "blocked";
  return "previewed";
}

/** The totals the confirmation repeats: the plan's totals, else its top-level figures. */
export function confirmationFigures(plan: PlanRecord): Array<[string, string]> {
  const source =
    plan.totals && typeof plan.totals === "object" && !Array.isArray(plan.totals)
      ? (plan.totals as PlanRecord)
      : plan.total && typeof plan.total === "object"
        ? (plan.total as PlanRecord)
        : plan;
  const figures: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(source)) {
    if (["planHash", "companyId"].includes(key)) continue;
    if (typeof value === "string" || typeof value === "number") figures.push([key, String(value)]);
    else if (Array.isArray(value)) figures.push([key, String(value.length)]);
  }
  if (source !== plan && (typeof plan.total === "string" || typeof plan.total === "number")) {
    figures.unshift(["total", String(plan.total)]);
  }
  return figures.slice(0, 12);
}

const GENERIC_BLOCKER_TEXT: Record<string, string> = {
  PERIOD_CLOSED: "The date is in a closed fiscal period.",
  REASON_REQUIRED: "A reason of at least 10 characters is required.",
  ACTION_REQUIRED: "Choose an action for every row before applying.",
};

interface CleanupToolPanelProps {
  tool: CleanupTool;
  role: string;
  modePrefix: string;
  /** The company the page shows; a plan the server built for another company cannot be applied. */
  companyId: number | null;
}

export function CleanupToolPanel({ tool, role, modePrefix, companyId }: CleanupToolPanelProps) {
  const [options, setOptions] = useState<ToolOptions>(tool.defaultOptions ?? {});
  const [plan, setPlan] = useState<PlanRecord | null>(null);
  const [planUrlUsed, setPlanUrlUsed] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<PlanRecord | null>(null);

  const testKey = tool.key;
  const planUrl = tool.planUrl(options);
  const canPreview = roleAllowed(role, tool.previewRoles);
  const canApply = !!tool.applyUrl && roleAllowed(role, tool.applyRoles);
  const optionsChanged = !!plan && planUrl !== planUrlUsed;
  const status = toolStatus(tool, plan, options, result !== null);
  const blockers = plan ? planBlockers(tool, plan, options) : [];
  const planHash = typeof plan?.planHash === "string" ? plan.planHash : null;
  const planCompanyId = typeof plan?.companyId === "number" ? plan.companyId : null;
  const otherCompany = planCompanyId !== null && companyId !== null && planCompanyId !== companyId;
  const applyReady =
    canApply &&
    !!plan &&
    !stale &&
    !otherCompany &&
    !optionsChanged &&
    result === null &&
    status === "previewed" &&
    (tool.sendsPlanHash === false || !!planHash);
  // A confirmed action with no plan (validate the ledger constraints): Apply needs only the confirmation.
  const actionReady = !!tool.actionOnly && canApply && result === null;

  const setOption = (key: string, value: unknown) => setOptions((current) => ({ ...current, [key]: value }));

  const preview = async () => {
    if (!planUrl) return;
    setPreviewing(true);
    setRefusal(null);
    setResult(null);
    try {
      const response = await apiRequestPrivileged("GET", planUrl);
      setPlan((await response.json()) as PlanRecord);
      setPlanUrlUsed(planUrl);
      setStale(false);
    } catch (error) {
      setPlan(null);
      setRefusal(describeRefusal(error));
    } finally {
      setPreviewing(false);
    }
  };

  const apply = async () => {
    if ((!plan && !tool.actionOnly) || !tool.applyUrl) return;
    setConfirmOpen(false);
    setApplying(true);
    setRefusal(null);
    try {
      const body = {
        confirm: true,
        ...(tool.sendsPlanHash === false || tool.actionOnly ? {} : { planHash }),
        ...(plan ? (tool.applyBody?.(plan, options) ?? {}) : {}),
      };
      const response = await apiRequestPrivileged("POST", tool.applyUrl, body);
      setResult(((await response.json()) as PlanRecord) ?? {});
    } catch (error) {
      const described = describeRefusal(error);
      setRefusal(described);
      if (described.kind === "planChanged") setStale(true);
    } finally {
      setApplying(false);
    }
  };

  const OptionsForm = tool.Options;
  const resultFigures = result ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "plan")) : null;

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid={`tool-${testKey}`} aria-label={tool.title}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium">{tool.title}</h3>
          <p className="text-sm text-muted-foreground">{tool.description}</p>
        </div>
        <Badge variant={STATUS_VARIANT[status]} className="self-start" data-testid={`badge-status-${testKey}`}>
          {STATUS_LABEL[status]}
        </Badge>
      </div>

      {OptionsForm && (
        <OptionsForm options={options} setOption={setOption} plan={plan} disabled={previewing || applying} />
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {!tool.actionOnly && (
          <Button
            variant="outline"
            onClick={preview}
            disabled={!canPreview || !planUrl || previewing || applying}
            className="w-full sm:w-auto"
            data-testid={`button-preview-${testKey}`}
          >
            {previewing ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {tool.applyUrl ? (plan ? "Preview again" : "Preview") : plan ? "Run again" : "Run check"}
          </Button>
        )}
        {tool.applyUrl && (
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!(applyReady || actionReady) || applying}
            className="w-full sm:w-auto"
            data-testid={`button-apply-${testKey}`}
          >
            {applying ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            Apply
          </Button>
        )}
      </div>
      {!canPreview && !tool.actionOnly && (
        <p className="text-xs text-muted-foreground">Only the Owner can preview this tool.</p>
      )}
      {canPreview && !planUrl && tool.inputHint && <p className="text-xs text-muted-foreground">{tool.inputHint}</p>}
      {canPreview && tool.applyUrl && !canApply && (
        <p className="text-xs text-muted-foreground">{tool.applyRoleHint ?? "Only the Owner can apply this tool."}</p>
      )}
      {optionsChanged && !result && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          The choices changed: preview again before applying.
        </p>
      )}

      {refusal && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
          role="alert"
          data-testid={`error-${testKey}`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <p>{refusal.message}</p>
            {refusal.serverMessage && refusal.serverMessage !== refusal.message && (
              <p className="text-xs wrap-break-word">{refusal.serverMessage}</p>
            )}
          </div>
        </div>
      )}

      {result && resultFigures && (
        <div
          className="space-y-2 rounded-md border border-emerald-300 p-3 dark:border-emerald-800"
          data-testid={`result-${testKey}`}
        >
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Applied
          </p>
          <PlanFigures plan={resultFigures} testId={`result-figures-${testKey}`} />
          <VoucherLinks
            vouchers={collectVouchers(result)}
            modePrefix={modePrefix}
            testId={`result-vouchers-${testKey}`}
          />
        </div>
      )}

      {otherCompany && (
        <p className="text-sm text-destructive" role="alert" data-testid={`warning-company-${testKey}`}>
          {`This plan is for company #${planCompanyId}, not the company selected here. Switch company and preview again.`}
        </p>
      )}

      {plan && (
        <div className="space-y-3" data-testid={`plan-${testKey}`}>
          {blockers.length > 0 && (
            <ul
              className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm"
              data-testid={`blockers-${testKey}`}
            >
              {blockers.map((code) => (
                <li key={code} className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{blockerLabel(tool, code)}</span>
                </li>
              ))}
            </ul>
          )}
          <PlanFigures plan={plan} testId={`plan-figures-${testKey}`} omit={["blockers", ...(tool.omit ?? [])]} />
          {planHash && (
            <p className="text-xs text-muted-foreground">
              {`Plan hash: `}
              <code>{planHash.slice(0, 12)}</code>
            </p>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid={`dialog-confirm-${testKey}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>{tool.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {tool.actionOnly
                ? tool.description
                : "The server derives the plan again and applies it only if it is still the one you reviewed. The changes and their audit row are written in one transaction."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {plan && (
            <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2" data-testid={`confirm-figures-${testKey}`}>
              {confirmationFigures(plan).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-2 border-b border-dashed py-1">
                  <dt className="text-muted-foreground">{fieldLabel(key)}</dt>
                  <dd className="font-mono tabular-nums" data-business-value>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-apply-${testKey}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={apply} data-testid={`button-confirm-apply-${testKey}`}>
              Apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
