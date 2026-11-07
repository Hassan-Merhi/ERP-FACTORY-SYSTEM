import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, RefreshCw } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { permissionAuditDiff, type AuditRule } from "./permissionAuditDiff";

type AuditRecord = {
  revision: string | number;
  actorId: string;
  subjectType: "role" | "user";
  subjectKey: string;
  beforeRules: AuditRule[];
  afterRules: AuditRule[];
  reason: string;
  createdAt: string;
};
type AuditResponse = { companyId: number; records: AuditRecord[] };

/** Shadow-only audit viewer. Never activates a permission or modifies audit history. */
export function PermissionChangeAudit() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const audit = useQuery<AuditResponse>({
    queryKey: ["/api/permissions-v2/audit", companyId],
    queryFn: async () => {
      const response = await fetch("/api/permissions-v2/audit?limit=100", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Audit records unavailable (HTTP ${response.status})`);
      return response.json() as Promise<AuditResponse>;
    },
    enabled: !!companyId,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const records = useMemo(() => {
    const data = audit.data;
    if (!data || !companyId || data.companyId !== companyId) return [];
    const term = search.trim().toLowerCase();
    return (data.records ?? []).filter((record) =>
      [record.actorId, record.subjectKey, record.subjectType, record.reason, String(record.revision)].some((value) =>
        value.toLowerCase().includes(term)
      )
    );
  }, [audit.data, companyId, search]);
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ClipboardList className="h-5 w-5" aria-hidden="true" /> Permission change audit
        </CardTitle>
        <CardDescription>
          Read-only history of this company's staged role and user permissions. Changes shown here are not live
          authorization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Filter permission audit"
            placeholder="Filter by actor, role, user, revision or reason"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-[180px] flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={audit.isFetching || !companyId}
            onClick={() => void audit.refetch()}
          >
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
        {audit.isLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading audit history…
          </p>
        )}
        {audit.isError && (
          <p role="alert" className="text-sm text-destructive">
            {audit.error.message}. Check the shadow database migration and your company access.
          </p>
        )}
        {audit.data && audit.data.companyId !== companyId && (
          <p role="alert" className="text-sm text-destructive">
            Company context changed. Refresh to view correct records.
          </p>
        )}
        {audit.isSuccess && records.length === 0 && (
          <p className="text-sm text-muted-foreground">No staged permission changes match this filter.</p>
        )}
        <div className="max-h-[480px] space-y-2 overflow-y-auto" aria-label="Permission audit records">
          {records.map((record) => {
            const key = `${record.revision}:${record.subjectType}:${record.subjectKey}`;
            const changes = permissionAuditDiff(record.beforeRules, record.afterRules);
            const open = expanded === key;
            return (
              <div key={key} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <span className="font-semibold">Revision {record.revision}</span>
                    <span className="ml-2 text-muted-foreground">
                      {record.subjectType}: {record.subjectKey}
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Actor: {record.actorId} · {new Date(record.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : key)}
                  >
                    {open ? "Hide changes" : `View ${changes.length} changes`}
                  </Button>
                </div>
                <p className="mt-1 text-sm">{record.reason}</p>
                {open && (
                  <div className="mt-2 max-h-60 overflow-y-auto rounded-md bg-muted/40 p-2 text-xs">
                    {changes.length === 0 ? (
                      <p>No rule delta recorded.</p>
                    ) : (
                      changes.map((row) => (
                        <p key={row.key} className="border-b py-1 last:border-0">
                          <span className="font-medium">{row.key}</span>: {row.before} → <strong>{row.after}</strong>
                        </p>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Displays up to the latest 100 staged revisions for this company. The underlying audit is append-only.
        </p>
      </CardContent>
    </Card>
  );
}
