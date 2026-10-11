/**
 * Owner "Accounting clean-up" page (accounting audit, owner decision of
 * 2026-10-11): every owner production step of docs/accounting-audit-2026-10.md
 * (sections 9 and 13, "Owner how-to") as an ordered checklist of cards. Each
 * card previews its tool's plan (GET), and applies only the reviewed plan
 * ({ confirm: true, planHash }) through the existing audited route. The
 * perpetual-inventory switch is not here: it stays a code flag.
 */
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";

import { CleanupToolPanel } from "./accounting-cleanup/CleanupToolPanel";
import { IntegrityStatusCard } from "./accounting-cleanup/CleanupStatusCards";
import { CLEANUP_STEPS } from "./accounting-cleanup/cleanupSteps";
import type { CleanupMode, CleanupStep } from "./accounting-cleanup/cleanupTypes";

/** The steps and tools of one mode, in order. */
export function cleanupStepsFor(mode: CleanupMode): CleanupStep[] {
  return CLEANUP_STEPS.filter((step) => !step.modes || step.modes.includes(mode)).map((step) => ({
    ...step,
    tools: step.tools.filter((tool) => !tool.modes || tool.modes.includes(mode)),
  }));
}

function CompanySelector({ mode }: { mode: CleanupMode }) {
  const { selectedCompany, companies, selectCompany } = useCompany();
  if (mode === "factory" || companies.length <= 1) {
    return (
      <p className="text-sm" data-testid="text-cleanup-company">
        <span className="text-muted-foreground">Company: </span>
        <span data-business-value>{selectedCompany?.name ?? "—"}</span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <Label htmlFor="cleanup-company" className="text-sm">
        Company
      </Label>
      <select
        id="cleanup-company"
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-72"
        value={selectedCompany?.id ?? ""}
        onChange={(event) => {
          const company = companies.find((entry) => entry.id === Number(event.target.value));
          if (company) void selectCompany(company);
        }}
        data-testid="select-cleanup-company"
      >
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function StepCard({
  step,
  mode,
  role,
  modePrefix,
  companyId,
  companyName,
}: {
  step: CleanupStep;
  mode: CleanupMode;
  role: string;
  modePrefix: string;
  companyId: number | null;
  companyName: string | null;
}) {
  const Extra = step.Extra;
  return (
    <Card data-testid={`card-cleanup-step-${step.step}`} data-step-key={step.key}>
      <CardHeader className="space-y-2">
        <CardTitle className="flex items-start gap-3 text-lg">
          <Badge variant="outline" className="shrink-0 font-mono" aria-hidden="true">
            {step.step}
          </Badge>
          <span className="min-w-0">{step.title}</span>
        </CardTitle>
        <CardDescription>{step.explanation}</CardDescription>
        <p className="text-sm">
          <span className="font-medium">Never: </span>
          <span className="text-muted-foreground">{step.never}</span>
        </p>
        {step.perCompany && (
          <p className="text-xs text-muted-foreground" data-testid={`text-step-company-${step.step}`}>
            <span>Acts on the selected company: </span>
            <span data-business-value>{companyName ?? "—"}</span>
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {Extra && <Extra mode={mode} role={role} modePrefix={modePrefix} />}
        {step.tools.map((tool) => (
          <CleanupToolPanel key={tool.key} tool={tool} role={role} modePrefix={modePrefix} companyId={companyId} />
        ))}
      </CardContent>
    </Card>
  );
}

export default function AccountingCleanup() {
  const mode: CleanupMode = useAppMode() === "factory" ? "factory" : "erp";
  const modePrefix = mode === "factory" ? "/factory" : "";
  const { data: user } = useQuery(authenticatedUserQueryOptions());
  const role = user?.currentRole ?? user?.role ?? "";
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const steps = cleanupStepsFor(mode);

  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-4" data-testid="page-accounting-cleanup">
      <PageHeader
        title="Accounting clean-up"
        subtitle="The Owner's production steps, in the order they must be done."
        icon={<ListChecks className="h-5 w-5" aria-hidden="true" />}
      />
      <Card>
        <CardContent className="space-y-2 pt-6 text-sm">
          <p>
            Work through the cards in order, company by company. Preview shows the plan in figures; Apply is enabled
            only for a preview without blockers, asks for confirmation and applies exactly the reviewed plan. If the
            data changed since the preview, the server refuses and you preview again.
          </p>
          <p className="text-muted-foreground">
            The perpetual inventory switch is not on this page: it is turned on in code after the reconciliation of step
            14 shows no difference.
          </p>
          <CompanySelector mode={mode} />
        </CardContent>
      </Card>
      <IntegrityStatusCard role={role} />
      {steps.map((step) => (
        <StepCard
          key={`${step.key}-${companyId ?? "none"}`}
          step={step}
          mode={mode}
          role={role}
          modePrefix={modePrefix}
          companyId={companyId}
          companyName={selectedCompany?.name ?? null}
        />
      ))}
    </div>
  );
}
