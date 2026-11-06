import { useQuery } from "@tanstack/react-query";
import { ChristmasModeSettingsCard } from "@/pages/settings/ChristmasModeSettingsCard";

/**
 * Factory Intelligence has a separate Settings screen from ERP / Properties.
 * Reuse the same Developer-only control while keeping other roles' pages clean.
 * API permissions are checked independently by the server.
 */
export function DeveloperChristmasModePanel() {
  const { data: user } = useQuery<{ role?: string }>({
    queryKey: ["/api/auth/me"],
  });
  if (user?.role !== "Developer") return null;
  return <ChristmasModeSettingsCard />;
}
