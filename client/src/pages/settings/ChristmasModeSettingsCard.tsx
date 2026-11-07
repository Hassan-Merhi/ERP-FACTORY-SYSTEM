import { useMemo, useState } from "react";
import {
  CalendarDays,
  Gift,
  Globe2,
  Layers3,
  Search,
  ShieldCheck,
  Snowflake,
  Sparkles,
  TreePine,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useChristmasModeConfiguration,
  defaultChristmasVisuals,
  type ChristmasEffectKey,
  type ChristmasVisualSettings,
} from "@/hooks/useChristmasMode";

type ChristmasDraft = { enabled: boolean; userIds: string[]; visuals: ChristmasVisualSettings };

const EFFECT_CONTROLS = [
  {
    key: "snowfall",
    name: "Snowfall & snow caps",
    description: "Falling snow and subtle winter accents on header and panels.",
    icon: Snowflake,
  },
  {
    key: "santa",
    name: "Santa flyover",
    description: "Reindeer, golden sparkles and sleigh across the top bar.",
    icon: Sparkles,
  },
  {
    key: "garlands",
    name: "Garland lights",
    description: "Pine garlands, glowing lights and ornaments.",
    icon: TreePine,
  },
  {
    key: "countdown",
    name: "Christmas countdown",
    description: "Compact live countdown near the top bar.",
    icon: CalendarDays,
  },
  { key: "gifts", name: "Surprise gifts", description: "Optional seasonal gift and interactive greeting.", icon: Gift },
  {
    key: "ambient",
    name: "Ambient Christmas corner",
    description: "A tasteful, compact Christmas tree and warm fireplace.",
    icon: TreePine,
  },
] as const satisfies ReadonlyArray<{
  key: ChristmasEffectKey;
  name: string;
  description: string;
  icon: typeof Snowflake;
}>;

/** Accessible only from Developer Settings; the server independently enforces it. */
export function ChristmasModeSettingsCard() {
  const { toast } = useToast();
  const { configQuery, saveConfig } = useChristmasModeConfiguration();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ChristmasDraft | null>(null);

  const config = configQuery.data;
  const enabled = draft?.enabled ?? config?.enabled ?? false;
  const selectedIds = useMemo(() => draft?.userIds ?? config?.userIds ?? [], [draft?.userIds, config?.userIds]);
  const visuals = draft?.visuals ?? config?.visuals ?? defaultChristmasVisuals;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filteredUsers = useMemo(
    () => (config?.users ?? []).filter((user) => user.username.toLowerCase().includes(search.trim().toLowerCase())),
    [config?.users, search]
  );
  const changed =
    draft !== null &&
    (draft.enabled !== config?.enabled ||
      draft.userIds.length !== (config?.userIds.length ?? 0) ||
      draft.userIds.some((id) => !config?.userIds.includes(id)) ||
      JSON.stringify(draft.visuals) !== JSON.stringify(config?.visuals ?? defaultChristmasVisuals));
  const loading = configQuery.isLoading;
  const saving = saveConfig.isPending;

  const edit = (next: Partial<ChristmasDraft>) => {
    setDraft((previous) => ({
      enabled: next.enabled ?? previous?.enabled ?? config?.enabled ?? false,
      userIds: next.userIds ?? previous?.userIds ?? config?.userIds ?? [],
      visuals: next.visuals ?? previous?.visuals ?? config?.visuals ?? defaultChristmasVisuals,
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
      { enabled, userIds: selectedIds, visuals },
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
          Select who can use Christmas Mode, then customize its six visual effects and atmosphere. The existing login
          jingle remains unchanged.
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
            <section
              className="rounded-2xl border border-amber-300/20 bg-gradient-to-br from-violet-500/10 via-background to-emerald-500/5 p-4 shadow-sm"
              data-testid="christmas-control-center"
            >
              <div className="mb-4 flex items-center gap-3">
                <span className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-2.5 text-amber-600 dark:text-amber-300">
                  <Gift className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="font-semibold text-base">Christmas Control Center</h3>
                  <p className="text-xs text-muted-foreground">
                    Personalized festive details across all company types.
                  </p>
                </div>
              </div>
              <div className="divide-y rounded-xl border bg-background/60">
                {EFFECT_CONTROLS.map((effect) => {
                  const Icon = effect.icon;
                  return (
                    <div key={effect.key} className="flex items-center justify-between gap-3 p-3">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">{effect.name}</span>
                          <span className="block text-xs text-muted-foreground">{effect.description}</span>
                        </span>
                      </span>
                      <Switch
                        checked={visuals.effects[effect.key]}
                        disabled={loading || saving}
                        aria-label={`Enable ${effect.name}`}
                        data-testid={`christmas-effect-${effect.key}`}
                        onCheckedChange={(next) =>
                          edit({ visuals: { ...visuals, effects: { ...visuals.effects, [effect.key]: next } } })
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Layers3 className="h-4 w-4 text-muted-foreground" /> Intensity
                </span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Christmas animation intensity">
                  {(["subtle", "balanced", "full"] as const).map((intensity) => (
                    <Button
                      key={intensity}
                      type="button"
                      size="sm"
                      variant={visuals.intensity === intensity ? "default" : "outline"}
                      aria-pressed={visuals.intensity === intensity}
                      disabled={loading || saving}
                      data-testid={`christmas-intensity-${intensity}`}
                      onClick={() => edit({ visuals: { ...visuals, intensity } })}
                    >
                      {intensity === "full" ? "Full Christmas" : intensity[0].toUpperCase() + intensity.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Balanced is the default. Scanner cameras, reduced-motion and data-saver preferences take priority over
                animations.
              </p>
            </section>
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    Users allowed to see Christmas Mode
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select individual users. New users are not added automatically. Each selected user can turn off the
                    effects in My Settings.
                  </p>
                </div>
                <span
                  className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold"
                  data-testid="christmas-selected-count"
                >
                  {selectedIds.length} selected
                </span>
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
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
                    <div key={user.id} className="flex items-center gap-3 px-3 py-3 text-sm hover:bg-muted/40">
                      <Checkbox
                        id={`christmas-user-${user.id}`}
                        checked={selectedSet.has(user.id)}
                        disabled={saving}
                        onCheckedChange={(checked) => toggleUser(user.id, checked === true)}
                        aria-label={`Allow Christmas Mode for ${user.username}`}
                      />
                      <label
                        htmlFor={`christmas-user-${user.id}`}
                        className="min-w-0 flex-1 cursor-pointer truncate font-medium"
                      >
                        {user.username}
                      </label>
                      <span className="text-xs text-muted-foreground">
                        {selectedSet.has(user.id) ? "Allowed" : "Off"}
                      </span>
                    </div>
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
                Access is per user across every company they can open. The master switch is OFF by default; everyone not
                selected remains excluded, including Admin and Owner accounts. Changes to other users' sessions appear
                on their next settings refresh.
              </span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
