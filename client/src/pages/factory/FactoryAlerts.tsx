import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Bell, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface Alert {
  id: number;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  entity: string;
  createdAt: string;
  read: boolean;
}

function getSeverityBadge(severity: string) {
  switch (severity) {
    case "critical":
      return (
        <Badge variant="destructive" data-testid={`badge-severity-${severity}`}>
          {severity}
        </Badge>
      );
    case "warning":
      return (
        <Badge
          variant="outline"
          className="border-yellow-500 text-yellow-600 dark:text-yellow-400"
          data-testid={`badge-severity-${severity}`}
        >
          {severity}
        </Badge>
      );
    case "info":
      return (
        <Badge
          variant="secondary"
          className="text-blue-600 dark:text-blue-400"
          data-testid={`badge-severity-${severity}`}
        >
          {severity}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" data-testid={`badge-severity-${severity}`}>
          {severity}
        </Badge>
      );
  }
}

export default function FactoryAlerts() {
  const alertsQuery = useQuery<Alert[]>({
    queryKey: ["/api/factory/alerts"],
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
  const unreadCount = alerts.filter((a) => !a.read).length;

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
          {alertsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading alerts...</span>
            </div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground" data-testid="text-no-data">
                No alerts found
              </p>
            </div>
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
                      className={alert.read ? "opacity-60" : ""}
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
                      <TableCell data-testid={`text-alert-entity-${alert.id}`}>{alert.entity}</TableCell>
                      <TableCell className="font-mono text-sm" data-testid={`text-alert-created-${alert.id}`}>
                        {new Date(alert.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {!alert.read ? (
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
