import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, FileX, MessageSquare, CheckCircle2, Truck, DollarSign } from "lucide-react";
import { fmt, fmtD, gitContainersUrl, parseNum } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";

export function TabWhatsApp() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [inclTrucks, setInclTrucks] = useState(false);
  const [inclAgents, setInclAgents] = useState(false);
  const [copied, setCopied] = useState(false);

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const containers: EnrichedContainerApi[] = data?.containers ?? [];

  const seaOtw = containers.filter((r) => r.status === "OTW" || r.status === "Sea").length;
  const atPort = containers.filter((r) => r.status === "At Port").length;
  const leftDar = containers.filter((r) => r.status === "Left Dar").length;
  const inTransit = containers.filter((r) => ["At Border", "In Transit"].includes(r.status)).length;
  const arrived = containers.filter((r) => r.status === "Arrived").length;

  const delayed = containers.filter((r) => r.daysDelayed !== null && r.daysDelayed > 0);
  const docsMiss = containers.filter((r) => !r.docReceived);
  const overdue = containers.filter((r) => r.isOverdue);

  const totalCost = containers.reduce((s, r) => s + parseNum(r.grandTotal), 0);
  const totalFee = containers.reduce((s, r) => s + parseNum(r.transportFee), 0);
  const totalDuty = containers.reduce((s, r) => s + parseNum(r.dutyFee), 0);

  const companies = [...new Set(containers.map((r) => r.companyName))].sort();
  const companyLines = companies.map((c) => {
    const sub = containers.filter((r) => r.companyName === c);
    const cost = sub.reduce((s, r) => s + parseNum(r.grandTotal), 0);
    return `• ${c}: ${sub.length} ctr${cost > 0 ? ` — $${fmt(cost, 0)}` : ""}`;
  });

  const tpNames = [...new Set(containers.filter((r) => r.transporter).map((r) => r.transporter!))].sort();
  const noTpCount = containers.filter((r) => !r.transporter).length;
  const tpLines = [
    ...tpNames.map((tp) => {
      const sub = containers.filter((r) => r.transporter === tp);
      const fee = sub.reduce((s, r) => s + parseNum(r.transportFee), 0);
      return `• ${tp}: ${sub.length} ctr${fee > 0 ? ` — $${fmt(fee, 0)}` : ""}`;
    }),
    ...(noTpCount > 0 ? [`• Unassigned: ${noTpCount} ctr`] : []),
  ];

  const agentNames = [...new Set(containers.filter((r) => r.agent).map((r) => r.agent!))].sort();
  const agentLines = agentNames.map((ag) => {
    const sub = containers.filter((r) => r.agent === ag);
    const duty = sub.reduce((s, r) => s + parseNum(r.dutyFee), 0);
    return `• ${ag}: ${sub.length} ctr${duty > 0 ? ` — $${fmt(duty, 0)} duty` : ""}`;
  });

  const today = new Date()
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();

  const truckLines: string[] = inclTrucks
    ? (() => {
        const withTruck = containers.filter((r) => !!(r.numberPlate ?? "").trim());
        if (withTruck.length === 0) return [``, `*TRUCK / LOCATION STATUS*`, `• No containers on the road`];
        const tps = [...new Set(withTruck.map((r) => r.transporter ?? "Unknown"))].sort();
        return [
          ``,
          `*TRUCK / LOCATION STATUS (${withTruck.length} on the road)*`,
          ...tps.flatMap((tp) => {
            const rows = withTruck.filter((r) => (r.transporter ?? "Unknown") === tp);
            return [
              `${tp} (${rows.length}):`,
              ...rows.map(
                (r) =>
                  `  ${r.containerNumber} | ${r.companyName} | ${r.numberPlate ?? "—"} | ${r.trackingLocation ?? "—"} | ${r.agent ?? "—"}`
              ),
            ];
          }),
        ];
      })()
    : [];

  const dutyLines: string[] = inclAgents
    ? [
        ``,
        `*AGENT / DUTY SUMMARY*`,
        ...(agentLines.length > 0 ? agentLines : [`• No agent data`]),
        `• Active Duty Total: $${fmt(totalDuty, 0)}`,
      ]
    : [];

  const lines = [
    `*GIT DAILY REPORT — ${today}*`,
    ``,
    `*ACTIVE CONTAINERS: ${containers.length}*`,
    `• OTW / At Sea:      ${seaOtw}`,
    `• At Port (Dar):     ${atPort}`,
    `• Left Dar:          ${leftDar}`,
    `• In Transit:        ${inTransit}`,
    `• Arrived:           ${arrived}`,
    ``,
    `*FINANCIALS*`,
    `• Container Cost:    $${fmt(totalCost, 0)}`,
    `• Transport Fees:    $${fmt(totalFee, 0)}`,
    `• Duty Fees:         $${fmt(totalDuty, 0)}`,
    `• Total Fees:        $${fmt(totalFee + totalDuty, 0)}`,
    ``,
    `*BY COMPANY*`,
    ...(companyLines.length > 0 ? companyLines : [`• No data`]),
    ``,
    `*BY TRANSPORTER*`,
    ...(tpLines.length > 0 ? tpLines : [`• No data`]),
    ``,
    `*BY AGENT / DECLARANT*`,
    ...(agentLines.length > 0 ? agentLines : [`• No data`]),
    ...(delayed.length > 0
      ? [
          ``,
          `⚠ *DELAYED — ${delayed.length}*`,
          ...delayed.map(
            (r) => `• ${r.containerNumber} +${r.daysDelayed}d [${r.companyName}] ${r.transporter ?? "no transporter"}`
          ),
        ]
      : []),
    ...(overdue.length > 0
      ? [
          ``,
          `! *OFFLOAD OVERDUE — ${overdue.length}*`,
          ...overdue.map((r) => `• ${r.containerNumber} [${r.companyName}]`),
        ]
      : []),
    ...(docsMiss.length > 0
      ? [
          ``,
          `*DOCS MISSING — ${docsMiss.length}*`,
          ...docsMiss.map((r) => `• ${r.containerNumber} [${r.companyName}] ETA ${fmtD(r.eta)}`),
        ]
      : []),
    ...(containers.filter((r) => r.trackingLink).length > 0
      ? [
          ``,
          `*TRACKING LINKS*`,
          ...containers.filter((r) => r.trackingLink).map((r) => `${r.containerNumber}: ${r.trackingLink}`),
        ]
      : []),
    ...truckLines,
    ...dutyLines,
  ];

  const text = lines.join("\n");

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const modeSelector = (
    <div className="max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:min-w-0 max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-1.5 flex items-center gap-2 flex-wrap">
      <span className="max-sm:hidden text-xs text-muted-foreground">Viewing:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        onClick={() => setCompanyMode("session")}
        data-testid="btn-wa-mode-session"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        onClick={() => setCompanyMode("all")}
        data-testid="btn-wa-mode-all"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-3 max-w-2xl">
        {modeSelector}
        <Skeleton className="h-96 w-full rounded-lg" />
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3 max-w-2xl">
        {modeSelector}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="text-xs mt-0.5">{(error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="flex items-center gap-2 flex-wrap">
        <MessageSquare className="h-4 w-4 text-green-600" />
        <p className="text-sm font-medium">Daily WhatsApp GIT Report</p>
        <Badge variant="outline" className="text-xs">
          Text preview — no PDF / image
        </Badge>
      </div>

      {modeSelector}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Include optional sections:</span>
        <Button
          size="sm"
          variant={inclTrucks ? "default" : "outline"}
          className="gap-1.5 text-xs"
          onClick={() => setInclTrucks((v) => !v)}
          data-testid="button-wa-trucks"
        >
          <Truck className="h-3 w-3" />
          Truck / Location
        </Button>
        <Button
          size="sm"
          variant={inclAgents ? "default" : "outline"}
          className="gap-1.5 text-xs"
          onClick={() => setInclAgents((v) => !v)}
          data-testid="button-wa-duty"
        >
          <DollarSign className="h-3 w-3" />
          Agent / Duty
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs ml-auto"
          onClick={handleCopy}
          data-testid="button-wa-copy"
        >
          {copied ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <MessageSquare className="h-3 w-3" />}
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>

      {containers.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm border rounded-lg border-dashed">
          <FileX className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="font-medium">No active containers found</div>
          <div className="text-xs mt-1">
            {companyMode === "all"
              ? "No containers exist across accessible companies."
              : "No containers exist for this company."}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-[#e5ddd5] dark:bg-zinc-800 p-3">
          <div className="bg-white dark:bg-zinc-700 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-[600px] overflow-y-auto">
            {text}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Text preview only. Copy and send manually to the WhatsApp group — no automated sending.
      </p>
    </div>
  );
}
