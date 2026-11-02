import { ArrowLeft, Layers, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

import { FactoryWorkerCategoriesPanel } from "./FactoryWorkerCategoriesPanel";
import { FactoryWorkersDialogs } from "./FactoryWorkersDialogs";
import { FactoryWorkersRosterPanel } from "./FactoryWorkersRosterPanel";
import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

/**
 * Keep category management as a URL-addressable sub-page rather than a second
 * Workers/Categories pill row. The model and its mutations stay unchanged.
 * The parent hubs clear "mode" whenever a different tab is selected.
 */
export function FactoryWorkersView({ model }: FactoryWorkersModelProps) {
  const { showWorkersList, showCategories, categories } = model;
  const modes = [
    ...(showWorkersList ? (["list"] as const) : []),
    ...(showCategories ? (["categories"] as const) : []),
  ];
  const [mode, setMode] = useHubQueryState<"list" | "categories">({
    key: "mode",
    allowedValues: modes,
    knownValues: ["list", "categories"],
    defaultValue: showWorkersList ? "list" : "categories",
    omitDefault: true,
  });

  if (!showWorkersList && !showCategories) {
    return <div className="rounded-xl border p-5 text-sm text-muted-foreground">No Workers pages are available for this user.</div>;
  }

  return (
    <div className="space-y-5">
      {mode === "categories" && showCategories ? (
        <section className="space-y-5" data-testid="worker-categories-page">
          <div className="flex flex-wrap items-center gap-3 border-b border-border/60 pb-4">
            {showWorkersList && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMode("list")}
                data-testid="button-back-to-workers"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Workers
              </Button>
            )}
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/10 p-2 text-primary"><Layers className="h-5 w-5" /></div>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Worker Categories</h2>
                <p className="text-sm text-muted-foreground">{categories.length} categories · Manage worker groups</p>
              </div>
            </div>
          </div>
          <Tabs value="categories">
            <FactoryWorkerCategoriesPanel model={model} />
          </Tabs>
        </section>
      ) : showWorkersList ? (
        <section aria-label="Workers roster" data-testid="workers-roster-page">
          <Tabs value="workers">
            <FactoryWorkersRosterPanel model={model} onOpenCategories={() => setMode("categories")} />
          </Tabs>
        </section>
      ) : (
        <div className="flex items-center gap-2 text-muted-foreground"><Users className="h-4 w-4" />No workers list available.</div>
      )}
      <FactoryWorkersDialogs model={model} />
    </div>
  );
}
