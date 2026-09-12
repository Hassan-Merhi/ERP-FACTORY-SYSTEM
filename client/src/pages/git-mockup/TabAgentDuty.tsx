import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, FileX, Building2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { AgentCard } from "./AgentCard";
import type {
  CompanyViewMode,
  AgentDutyResponse,
  AgentDutyCompanySection,
  AgentDutySummary,
  AgentDutyWaSettings,
} from "./types";

const CONF_RANK: Record<AgentDutySummary["matchConfidence"], number> = { exact: 0, fuzzy: 1, unmapped: 2 };

export function TabAgentDuty() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");

  const queryUrl =
    companyMode === "all" ? "/api/git/agent-duty-summary?allCompanies=true" : "/api/git/agent-duty-summary";

  const { data, isLoading, isError, error } = useQuery<AgentDutyResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const { data: waSettings } = useQuery<AgentDutyWaSettings>({
    queryKey: ["/api/git/agent-duty-wa-settings"],
    staleTime: 120_000,
  });

  const sections: AgentDutyCompanySection[] = useMemo(
    () =>
      !data
        ? []
        : data.mode === "all"
          ? data.companies
          : [{ companyId: data.companyId, companyName: data.companyName, agents: data.agents }],
    [data]
  );

  useEffect(() => {
    const uniqueCompanyIds = [...new Set(sections.map((s) => s.companyId))];
    for (const cid of uniqueCompanyIds) {
      fetch(`/api/git/agent-notes-bulk/${cid}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { notes: { agentName: string; note: string }[] } | null) => {
          if (!body) return;
          for (const { agentName, note } of body.notes) {
            const key = `/api/git/agent-note/${cid}/${encodeURIComponent(agentName)}`;
            if (!queryClient.getQueryData([key])) queryClient.setQueryData([key], { note });
          }
        })
        .catch(() => {});

      fetch(`/api/git/agent-adjustments-bulk/${cid}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (
            body: {
              byAgent: Record<string, { id: number; description: string; amount: number; type: string }[]>;
            } | null
          ) => {
            if (!body) return;
            for (const [agentName, adjustments] of Object.entries(body.byAgent)) {
              const key = `/api/git/agent-adjustments/${cid}/${encodeURIComponent(agentName)}`;
              if (!queryClient.getQueryData([key])) queryClient.setQueryData([key], adjustments);
            }
            const section = sections.find((s) => s.companyId === cid);
            if (section) {
              for (const agent of section.agents) {
                const key = `/api/git/agent-adjustments/${cid}/${encodeURIComponent(agent.agentName)}`;
                if (!queryClient.getQueryData([key])) queryClient.setQueryData([key], []);
              }
            }
          }
        )
        .catch(() => {});
    }
  }, [data, sections]);

  // In "all companies" mode always merge agents with the same name across companies.
  const displaySections: AgentDutyCompanySection[] = useMemo(() => {
    if (companyMode !== "all" || sections.length <= 1) return sections;
    const agentMap = new Map<string, AgentDutySummary[]>();
    for (const section of sections) {
      for (const agent of section.agents) {
        const key = agent.agentName.trim().toLowerCase();
        if (!agentMap.has(key)) agentMap.set(key, []);
        agentMap.get(key)!.push(agent);
      }
    }
    const merged: AgentDutySummary[] = [];
    for (const [, group] of agentMap) {
      if (group.length === 1) {
        merged.push(group[0]);
        continue;
      }
      const hasNullBalance = group.some((a) => a.ledgerBalance === null);
      const hasNullOpen = group.some((a) => a.openBalance === null);
      const accountNames = [...new Set(group.map((a) => a.ledgerAccountName).filter(Boolean))];
      const worstConf = group.reduce<AgentDutySummary["matchConfidence"]>(
        (best, a) => (CONF_RANK[a.matchConfidence] > CONF_RANK[best] ? a.matchConfidence : best),
        "exact"
      );
      merged.push({
        agentName: group[0].agentName,
        ledgerAccountId: null,
        ledgerAccountName: accountNames.length > 0 ? accountNames.join(" / ") : null,
        matchConfidence: worstConf,
        ledgerBalance: hasNullBalance ? null : group.reduce((s, a) => s + a.ledgerBalance!, 0),
        containerDutyTotal: group.reduce((s, a) => s + a.containerDutyTotal, 0),
        offloadedDutyTotal: group.reduce((s, a) => s + a.offloadedDutyTotal, 0),
        clearedByPayments: group.reduce((s, a) => s + a.clearedByPayments, 0),
        openBalance: hasNullOpen ? null : group.reduce((s, a) => s + a.openBalance!, 0),
        warnings: [...new Set(group.flatMap((a) => a.warnings))],
        clearedRows: group.flatMap((a) => a.clearedRows),
        partialRows: group.flatMap((a) => a.partialRows),
        openRows: group.flatMap((a) => a.openRows),
        activePreviewRows: group.flatMap((a) => a.activePreviewRows),
      });
    }
    merged.sort((a, b) => a.agentName.localeCompare(b.agentName));
    return [{ companyId: 0, companyName: "All Companies", agents: merged }];
  }, [companyMode, sections]);

  const totalAgents = displaySections.reduce((s, c) => s + c.agents.length, 0);

  const modeSelector = (
    <div className="flex items-center gap-2 flex-wrap" data-testid="agent-duty-mode-selector">
      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">View:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("session")}
        data-testid="button-agent-duty-my-company"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("all")}
        data-testid="button-agent-duty-all-companies"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-4">
        {modeSelector}
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-md border overflow-hidden">
            <Skeleton className="h-9 w-full rounded-none" />
            <div className="grid grid-cols-4 divide-x border-b">
              {[1, 2, 3, 4].map((j) => (
                <div key={j} className="px-2 py-3 space-y-1.5">
                  <Skeleton className="h-2.5 w-20 mx-auto" />
                  <Skeleton className="h-4 w-16 mx-auto" />
                  <Skeleton className="h-2 w-12 mx-auto" />
                </div>
              ))}
            </div>
            <div className="p-3 space-y-1.5">
              {[1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-5 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );

  if (isError)
    return (
      <div className="space-y-4">
        {modeSelector}
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3 flex gap-3 items-start text-sm text-red-800 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Failed to load Agent / Duty data</div>
            <div className="text-xs mt-0.5 text-red-700 dark:text-red-400">
              {(error as Error)?.message ?? "Network or server error."}
            </div>
          </div>
        </div>
      </div>
    );

  if (totalAgents === 0)
    return (
      <div className="space-y-4">
        {modeSelector}
        <div className="rounded-md border border-dashed px-6 py-10 text-center text-muted-foreground text-sm">
          <FileX className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="font-medium">No agent / duty data found</div>
          <div className="text-xs mt-1">
            {companyMode === "all"
              ? "No containers with a non-zero duty fee and agent name exist across accessible companies."
              : "No containers with a non-zero duty fee and agent name exist for this company."}
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      {modeSelector}
      {displaySections.map((section) => (
        <div key={section.companyId} className="space-y-4" data-testid={`company-section-${section.companyId}`}>
          {section.agents.filter(
            (a) =>
              (a.activePreviewRows.length > 0 || a.openRows.length > 0 || a.partialRows.length > 0) &&
              (a.openBalance === null || a.openBalance !== 0)
          ).length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              <FileX className="h-6 w-6 mx-auto mb-1.5 opacity-40" />
              <div className="text-xs">No agent / duty data for {section.companyName}</div>
            </div>
          ) : (
            section.agents
              .filter(
                (agent) =>
                  (agent.activePreviewRows.length > 0 || agent.openRows.length > 0 || agent.partialRows.length > 0) &&
                  (agent.openBalance === null || agent.openBalance !== 0)
              )
              .map((agent) => (
                <AgentCard
                  key={`${section.companyId}-${agent.agentName}`}
                  agent={agent}
                  companyId={section.companyId}
                  waGroupChatId={
                    waSettings?.groups?.[agent.agentName] ||
                    waSettings?.groups?.[agent.agentName.toUpperCase()] ||
                    undefined
                  }
                />
              ))
          )}
        </div>
      ))}
    </div>
  );
}
