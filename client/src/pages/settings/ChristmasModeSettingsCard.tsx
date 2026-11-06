import { useMemo, useState } from "react";
import { Globe2, Search, ShieldCheck, Snowflake, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useChristmasModeConfiguration } from "@/hooks/useChristmasMode";

type ChristmasDraft = { enabled: boolean; userIds: string[] };

/** Accessible only from Developer Settings; the server independently enforces it. */
export function ChristmasModeSettingsCard() {
  const { toast } = useToast();
  const { configQuery, saveConfig } = useChristmasModeConfiguration();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ChristmasDraft | null>(null);

  const config = configQuery.data;
  const enabled = draft?.enabled ?? config?.enabled ?? false;
  const selectedIds = draft?.userIds ?? config?.userIds ?? [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filteredUsers = useMemo(
    () => (config?.users ?? []).filter((user) => user.username.toLowerCase().includes(search.trim().toLowerCase())),
    [config?.users, search]
  );
  const changed =
    draft !== null &&
    (draft.enabled !== config?.enabled ||
      draft.userIds.length !== (config?.userIds.length ?? 0) ||
      draft.userIds.some((id) => !config?.userIds.includes(id)));
  const loading = configQuery.isLoading;
  const saving = saveConfig.isPending;

  const edit = (next: Partial<ChristmasDraft>) => {
    setDraft((previous) => ({
      enabled: next.enabled ?? previous?.enabled ?? config?.enabled ?? false,
      userIds: next.userIds ?? previous?.userIds ?? config?.userIds ?? [],
    }));
  };

  const toggleUser = (userId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(userId);
    else next.delete(userId);
    edit({ userIds: [...next] });
  };

  const save = () => {
    saveConfig.mutate(
      { enabled, userIds: selectedIds },
      {
        onSuccess: () => {
          setDraft(null);
          toast({
            title: "Christmas Mode access saved",
            description: "Only selected users will receive the effects when the master switch is ON.",
          });
        },
        onError: (error) =>
          toast({
            title: "Unable to update Christmas Mode",
            description: error.message || "Your changes were not saved.",
            variant: "destructive",
          }),
      }
    );
  };

  return (
    <Card className="max-w-3xl" data-testid="settings-christmas-mode-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Snowflake className="h-5 w-5 text-sky-500" aria-hidden="true" />
          Christmas Mode
        </CardTitle>
        <CardDescription>
          Developer-only control for snowfall, festive lights, sidebar ornaments and
          the Christmas login welcome. Enable it for specific user accounts only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {configQuery.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            Could not load Christmas Mode access settings.
            <Button type="button" variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/20 p-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold">Master Christmas Mode switch</p>
                <p className="text-xs text-muted-foreground">
                  Only the selected accounts below can see the effects while this is ON.
                </p>
              </div>
              <Switch
                aria-label="Enable Christmas Mode for selected users"
                data-testid="settings-switch-christmas-mode"
                checked={enabled}
                disabled={loading || saving}
                onCheckedChange={(next) => edit({ enabled: next })}
              />
            </div>
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    Users allowed to see Christmas Mode
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select individual users. New users are not added automatically.
                  </p>
                </div>
                <span className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold" data-testid="christmas-selected-count">
                  {selectedIds.length} selected
                </span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  aria-label="Search Christmas Mode users"
                  placeholder="Search users by username..."
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={loading || saving}
                />
              </div>
              <div
                className="max-h-72 overflow-y-auto rounded-xl border bg-background divide-y"
                role="group"
                aria-label="Allowed Christmas Mode users"
                data-testid="christmas-user-list"
              >
                {loading ? (
                  <p className="p-4 text-sm text-muted-foreground">Loading active users...</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    {search ? "No matching users." : "No active users available."}
                  </p>
                ) : (
                  filteredUsers.map((user) => (
                    <label
                      key={user.id}
                      className="flex cursor-pointer items-center gap-3 px-3 py-3 text-sm hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={selectedSet.has(user.id)}
                        disabled={saving}
                        onCheckedChange={(checked) => toggleUser(user.id, checked === true)}
                        aria-label={`Allow Christmas Mode for ${user.username}`}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{user.username}</span>
                      <span className="text-xs text-muted-foreground">
                        {selectedSet.has(user.id) ? "Allowed" : "Off"}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {enabled && selectedIds.length > 0
                    ? `Enabled for ${selectedIds.length} selected user${selectedIds.length === 1 ? "" : "s"} once saved.`
                    : "No users will see Christmas effects unless the master switch is ON and they are selected."}
                </span>
              </div>
              <Button
                type="button"
                onClick={save}
                disabled={!changed || loading || saving}
                data-testid="button-save-christmas-access"
              >
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground" role="status">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Access is per user across every company they can open. The master switch is OFF by default;
                everyone not selected remains excluded, including Admin and Owner accounts.
                Changes to other users' sessions appear on their next settings refresh.
              </span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
