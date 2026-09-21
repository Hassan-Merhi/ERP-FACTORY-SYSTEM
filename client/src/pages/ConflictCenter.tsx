import { visibleTabInterval } from "@/lib/queryPolicies";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, RefreshCw, Trash2, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { getUnresolvedConflicts, resolveConflict, addToSyncQueue, type Conflict } from "@/lib/db";

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ts));
}

function tryPrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function ConflictCard({ conflict, onResolved }: { conflict: Conflict; onResolved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  const local = tryPrettyJson(conflict.localPayload);
  const server = tryPrettyJson(conflict.serverResponse);

  const handleAcceptServer = async () => {
    if (!conflict.id) return;
    await resolveConflict(conflict.id, "server");
    toast({ title: "Conflict resolved", description: "Server version accepted." });
    onResolved();
  };

  const handleAcceptLocal = async () => {
    if (!conflict.id) return;
    // Re-queue the local payload so it gets synced again
    if (conflict.url) {
      try {
        await addToSyncQueue({
          idempotencyKey: `conflict-retry-${conflict.id}-${Date.now()}`,
          mode: "erp",
          entityType: conflict.entityType,
          operation: conflict.operation as "create" | "update" | "delete",
          payload: conflict.localPayload,
          url: conflict.url,
          method: conflict.method || "POST",
          companyId: null,
          locationId: null,
          tempId: null,
          description: `Conflict retry: ${conflict.entityType}`,
        });
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
    }
    await resolveConflict(conflict.id, "local");
    toast({
      title: "Conflict resolved",
      description: conflict.url ? "Local version queued for sync." : "Marked resolved — please re-enter manually.",
    });
    onResolved();
  };

  const handleDiscard = async () => {
    if (!conflict.id) return;
    await resolveConflict(conflict.id, "server");
    toast({ title: "Discarded", description: "Local change discarded." });
    onResolved();
  };

  return (
    <Card data-testid={`conflict-card-${conflict.id}`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
              {conflict.entityType}
              <Badge variant="outline" className="text-xs capitalize">
                {conflict.operation}
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">{formatTime(conflict.createdAt)}</CardDescription>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleAcceptServer}
              data-testid={`btn-accept-server-${conflict.id}`}
            >
              Accept server version
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={handleAcceptLocal}
              data-testid={`btn-accept-local-${conflict.id}`}
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Retry local version
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={handleDiscard}
              data-testid={`btn-discard-${conflict.id}`}
              title="Discard local change"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>

        {conflict.conflictReason && (
          <p className="text-xs text-muted-foreground mt-1 bg-muted/50 rounded-md px-2 py-1">
            {conflict.conflictReason}
          </p>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground px-0 gap-1"
          onClick={() => setExpanded((v) => !v)}
          data-testid={`btn-expand-conflict-${conflict.id}`}
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? "Hide details" : "Show details"}
        </Button>

        {expanded && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Your local change</p>
              <pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {local}
              </pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Server response</p>
              <pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {server}
              </pre>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ConflictCenter() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: conflicts = [],
    isLoading,
    refetch,
  } = useQuery<Conflict[]>({
    queryKey: ["conflicts", "unresolved"],
    queryFn: () => getUnresolvedConflicts(),
    refetchInterval: visibleTabInterval(60_000),
  });

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const all = await getUnresolvedConflicts();
      await Promise.all(all.map((c) => (c.id ? resolveConflict(c.id, "server") : Promise.resolve())));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      toast({ title: "All conflicts dismissed", description: "All conflicts marked as resolved." });
    },
  });

  const handleResolved = () => {
    queryClient.invalidateQueries({ queryKey: ["conflicts"] });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <PageHeader title="Conflict Center" icon={<AlertTriangle className="h-5 w-5" />} />
          <p className="text-sm text-muted-foreground mt-1">
            Review and resolve sync conflicts between your offline changes and the server.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-refresh-conflicts">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
          {conflicts.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
              data-testid="btn-dismiss-all-conflicts"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Dismiss all
            </Button>
          )}
        </div>
      </div>

      <Separator />

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading conflicts…</div>
      ) : conflicts.length === 0 ? (
        <div className="text-center py-16 space-y-3" data-testid="no-conflicts-message">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          <p className="text-lg font-medium">No conflicts</p>
          <p className="text-sm text-muted-foreground">All your offline changes synced cleanly with the server.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {conflicts.length} unresolved {conflicts.length === 1 ? "conflict" : "conflicts"}
          </p>
          {conflicts.map((conflict) => (
            <ConflictCard key={conflict.id} conflict={conflict} onResolved={handleResolved} />
          ))}
        </div>
      )}
    </div>
  );
}
