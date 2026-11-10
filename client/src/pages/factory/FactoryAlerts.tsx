import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, EmptyState, ErrorState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { Loader2, Bell, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface Alert {
  id: number;
  severity: "critical" | "error" | "warning" | "info";
  title: string;
  message: string | null;
  entityType: string | null;
  entityId: number | null;
  createdAt: string;
  isRead: boolean;
}

function getSeverityBadge(severity: string) {
  const visibleSeverity = severity === "error" ? "critical" : severity;
  return (
    <StatusBadge
      status={visibleSeverity}
      label={visibleSeverity}
      showIcon={false}
      data-testid={`badge-severity-${visibleSeverity}`}
    />
  );
}

export default function FactoryAlerts() {
  const { selectedCompany } = useCompany();
  const alertsQuery = useQuery<Alert[]>({
    queryKey: companyQueryKey("/api/factory/alerts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    refetchInterval: 300_000,
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      await factoryApiRequest("POST", "/api/factory/alerts/generate");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/alerts"] });
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: number) => {
      await factoryApiRequest("POST", `/api/factory/alerts/${id}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/alerts"] });
    },
  });

  const alerts = alertsQuery.data ?? [];
  const unreadCount = alerts.filter((a) => !a.isRead).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Factory Alerts" />
          <p className="text-muted-foreground mt-1">
            <span data-testid="text-unread-count">{unreadCount}</span> unread alert{unreadCount !== 1 ? "s" : ""}
          </p>
        </div>
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          data-testid="button-generate-alerts"
        >
          {generateMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Generate Alerts
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Alerts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {generateMutation.isError ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              Alert generation failed. Please try again.
            </p>
          ) : null}
          {markReadMutation.isError ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              Could not mark the alert as read. Please try again.
            </p>
          ) : null}
          {alertsQuery.isLoading ? (
            <LoadingState title="Loading alerts..." data-testid="loading-spinner" />
          ) : alertsQuery.isError ? (
            <ErrorState
              title="Alerts could not be loaded"
              description="The alert service did not respond. Your alert records have not been changed."
              actionLabel="Try again"
              onAction={() => {
                void alertsQuery.refetch();
              }}
            />
          ) : alerts.length === 0 ? (
            <EmptyState
              title="No alerts found"
              description="Generated alerts will appear here."
              icon={Bell}
              data-testid="text-no-data"
            />
          ) : (
            <div className="table-responsive">
              <Table mobileLayout="cards" data-testid="factory-alerts-table">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Severity</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((alert) => (
                    <TableRow
                      key={alert.id}
                      className={alert.isRead ? "opacity-60" : ""}
                      data-testid={`row-alert-${alert.id}`}
                    >
                      {/* Severity is a labelled field on phone cards; the alert title heads the card. */}
                      <TableCell data-mobile-cell="field">{getSeverityBadge(alert.severity)}</TableCell>
                      <TableCell className="font-medium" data-testid={`text-alert-title-${alert.id}`}>
                        {alert.title}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground sm:max-w-xs sm:truncate"
                        data-testid={`text-alert-message-${alert.id}`}
                      >
                        {alert.message}
                      </TableCell>
                      <TableCell data-testid={`text-alert-entity-${alert.id}`}>
                        {alert.entityType ? `${alert.entityType} #${alert.entityId ?? "?"}` : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-sm" data-testid={`text-alert-created-${alert.id}`}>
                        {new Date(alert.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {!alert.isRead ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => markReadMutation.mutate(alert.id)}
                            disabled={markReadMutation.isPending}
                            data-testid={`button-mark-read-${alert.id}`}
                          >
                            Mark Read
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground" data-testid={`text-read-${alert.id}`}>
                            Read
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
