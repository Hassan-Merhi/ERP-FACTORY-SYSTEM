import { useState } from "react";
import { Card } from "@/components/ui/card";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";

import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { SettingsLoginHistoryRow } from "./settingsTypes";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

export function LoginHistoryTab() {
  const { tableProps } = useMobileCardTable();
  const { formatDisplayDate } = useDateFormat();
  const {
    data: history,
    isLoading,
    isError,
    refetch,
  } = useQuery<SettingsLoginHistoryRow[]>({
    queryKey: ["/api/login-history"],
  });

  const [filterUser, setFilterUser] = useState("");

  const filteredHistory =
    history?.filter((entry) => {
      if (!filterUser) return true;
      return entry.username.toLowerCase().includes(filterUser.toLowerCase());
    }) || [];

  if (isLoading) {
    return <LoadingState className="py-12" />;
  }

  if (isError && !history) {
    return <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-12" />;
  }

  return (
    <div className="space-y-4" data-testid="section-login-history">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold" data-testid="text-login-history-title">
          Login History
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <SearchField
            placeholder="Filter by username..."
            value={filterUser}
            onValueChange={setFilterUser}
            wrapperClassName="w-full sm:w-48"
            data-testid="input-filter-username"
          />
        </div>
      </div>

      {filteredHistory.length === 0 ? (
        <EmptyState title="No login history found." className="py-8" />
      ) : (
        <Card>
          <div className="table-responsive">
            <table className="w-full text-sm" data-testid="table-login-history" {...tableProps}>
              <thead className="sticky top-0 z-30 bg-muted">
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">User</th>
                  <th className="text-left p-3 font-medium">Company</th>
                  <th className="text-left p-3 font-medium">Date & Time</th>
                  <th className="text-left p-3 font-medium">IP Address</th>
                  <th className="text-left p-3 font-medium">Location</th>
                  <th className="text-left p-3 font-medium">Device</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((entry) => {
                  const loginDate = new Date(entry.loginAt);
                  const locationParts = [entry.city, entry.country].filter(Boolean);
                  const locationStr = locationParts.length > 0 ? locationParts.join(", ") : "Unknown";

                  const ua = entry.userAgent || "";
                  let deviceStr = "Unknown";
                  if (ua.includes("Mobile")) deviceStr = "Mobile";
                  else if (ua.includes("Tablet")) deviceStr = "Tablet";
                  else if (ua.includes("Windows")) deviceStr = "Windows";
                  else if (ua.includes("Mac")) deviceStr = "Mac";
                  else if (ua.includes("Linux")) deviceStr = "Linux";
                  else if (ua.includes("Chrome")) deviceStr = "Chrome";
                  else if (ua.includes("Firefox")) deviceStr = "Firefox";

                  return (
                    <tr
                      key={entry.id}
                      className="border-b last:border-0 hover-elevate"
                      data-testid={`row-login-${entry.id}`}
                    >
                      <td className="p-3 font-medium" data-testid={`text-login-user-${entry.id}`}>
                        {entry.username}
                      </td>
                      <td className="p-3 text-muted-foreground" data-testid={`text-login-company-${entry.id}`}>
                        {entry.companyName || "-"}
                      </td>
                      <td className="p-3 text-muted-foreground" data-testid={`text-login-date-${entry.id}`}>
                        {formatDisplayDate(loginDate)} {loginDate.toLocaleTimeString()}
                      </td>
                      <td
                        className="p-3 font-mono text-xs text-muted-foreground"
                        data-testid={`text-login-ip-${entry.id}`}
                      >
                        {entry.ipAddress || "-"}
                      </td>
                      <td className="p-3 text-muted-foreground" data-testid={`text-login-location-${entry.id}`}>
                        {locationStr}
                      </td>
                      <td className="p-3 text-muted-foreground" data-testid={`text-login-device-${entry.id}`}>
                        {deviceStr}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Showing last {filteredHistory.length} login events. Location data is approximate and based on IP address.
      </p>
    </div>
  );
}
