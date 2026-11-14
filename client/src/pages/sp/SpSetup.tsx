import { PageHeader } from "@/components/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { getQueryFn } from "@/lib/queryClient";
import SpSetupPanel from "@/pages/sp/SpSetupPanel";
import type { AuthMe } from "@shared/apiTypes";

export default function SpSetup() {
  const { data: user, isLoading } = useQuery<AuthMe>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    staleTime: 30 * 60 * 1000,
  });

  if (isLoading) return null;
  const role = user?.currentRole ?? user?.role;
  const canSetup = role === "Admin" || role === "Developer";

  if (!canSetup) return <Redirect replace to="/sp" />;

  return (
    <div className="space-y-4" data-testid="sp-administration-hub">
      <PageHeader title="Supplier Partner Setup" subtitle="Configure and repair Supplier Partner accounts and links." />

      <SpSetupPanel />
    </div>
  );
}
