import { useState } from "react";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { FactoryWorkerCategoriesPanel } from "./FactoryWorkerCategoriesPanel";
import { FactoryWorkersDialogs } from "./FactoryWorkersDialogs";
import { FactoryWorkersRosterPanel } from "./FactoryWorkersRosterPanel";
import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

export function FactoryWorkersView({ model }: FactoryWorkersModelProps) {
  const { showWorkersList, showCategories, categories } = model;
  const visibleTabs = [showWorkersList ? "workers" : null, showCategories ? "categories" : null].filter(
    (value): value is "workers" | "categories" => value !== null
  );
  const [requestedTab, setRequestedTab] = useState<"workers" | "categories">("workers");
  const activeTab = visibleTabs.includes(requestedTab) ? requestedTab : visibleTabs[0];

  return (
    <div className="space-y-5">
      {activeTab ? (
      <Tabs value={activeTab} onValueChange={(value) => setRequestedTab(value as "workers" | "categories")}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList>
            {showWorkersList && (
              <TabsTrigger value="workers" data-testid="tab-workers">
                Workers
              </TabsTrigger>
            )}
            {showCategories && (
              <TabsTrigger value="categories" data-testid="tab-categories">
                <Layers className="h-3.5 w-3.5 mr-1.5" />
                Categories
                {categories.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs no-default-active-elevate">
                    {categories.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {showWorkersList && <FactoryWorkersRosterPanel model={model} />}
        {showCategories && <FactoryWorkerCategoriesPanel model={model} />}
      </Tabs>
      ) : (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          No Workers List tabs are available for this user.
        </div>
      )}
      <FactoryWorkersDialogs model={model} />
    </div>
  );
}
