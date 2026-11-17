import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Shield, Activity, History } from "lucide-react";
import { ActiveUsersSection } from "./ActiveUsersSection";
import { ActiveSessionsTab } from "./ActiveSessionsTab";
import { LoginHistoryTab } from "./LoginHistoryTab";
import { GlobalForceRefreshCard } from "./GlobalForceRefreshCard";

const SESSIONS_TABS = ["sessions", "login-history", "watch"] as const;
type SessionsTab = (typeof SESSIONS_TABS)[number];

export function SessionsHub({ isAdmin, isDev }: { isAdmin: boolean; isDev: boolean }) {
  const canWatchUsers = isAdmin || isDev;
  const [tab, setTab] = useHubQueryState<SessionsTab>({
    key: "tab",
    allowedValues: canWatchUsers ? SESSIONS_TABS : SESSIONS_TABS.filter((value) => value !== "watch"),
    knownValues: SESSIONS_TABS,
    defaultValue: isDev ? "watch" : "sessions",
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5" />
          Sessions & Users
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Monitor active sessions, login history, and watch real-time user activity.
        </p>
      </div>

      {isAdmin && <GlobalForceRefreshCard />}

      <Tabs value={tab} onValueChange={(value) => setTab(value as SessionsTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Session sections">
            <TabsTrigger value="sessions" className="flex items-center gap-1">
              <Shield className="h-3.5 w-3.5" />
              Active Sessions
            </TabsTrigger>
            <TabsTrigger value="login-history" className="flex items-center gap-1">
              <History className="h-3.5 w-3.5" />
              Login History
            </TabsTrigger>
            {canWatchUsers && (
              <TabsTrigger value="watch" className="flex items-center gap-1">
                <Activity className="h-3.5 w-3.5" />
                Active Users Watch
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="sessions" className="mt-4">
          <ActiveSessionsTab isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="login-history" className="mt-4">
          <LoginHistoryTab />
        </TabsContent>
        {canWatchUsers && (
          <TabsContent value="watch" className="mt-4">
            <ActiveUsersSection />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
