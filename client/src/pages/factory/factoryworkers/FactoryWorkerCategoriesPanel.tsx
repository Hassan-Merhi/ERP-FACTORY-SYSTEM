import { Plus, Pencil, Layers, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { TabsContent } from "@/components/ui/tabs";

import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

export function FactoryWorkerCategoriesPanel({ model }: FactoryWorkersModelProps) {
  const { showCategories, workers, categories, deleteCatMutation, openNewCategory, openEditCategory } = model;

  return (
    <>
      {showCategories && (
        <TabsContent value="categories" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Group workers into categories to quickly filter them during stock entry and history.
              </p>
              <Button onClick={openNewCategory} data-testid="button-add-category">
                <Plus className="h-4 w-4 mr-2" />
                New Category
              </Button>
            </div>

            {categories.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground border rounded-md">
                <Layers className="mx-auto h-8 w-8 mb-3 opacity-40" />
                <p className="font-medium">No categories yet</p>
                <p className="text-sm mt-1">Create a category to group workers for quick filtering</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {categories.map((cat) => {
                  const ids = Array.isArray(cat.workerIds) ? (cat.workerIds as number[]) : [];
                  const catWorkers = (workers ?? []).filter((w) => ids.includes(w.id));
                  const activeMembers = catWorkers.filter((w) => w.active);
                  return (
                    <div
                      key={cat.id}
                      className="rounded-xl border p-4 space-y-3"
                      data-testid={`card-category-${cat.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-sm" data-testid={`text-cat-name-${cat.id}`}>
                            {cat.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {activeMembers.length} active worker{activeMembers.length !== 1 ? "s" : ""}
                          </p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEditCategory(cat)}
                            data-testid={`button-edit-cat-${cat.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => deleteCatMutation.mutate(cat.id)}
                            disabled={deleteCatMutation.isPending}
                            data-testid={`button-delete-cat-${cat.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                      {activeMembers.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {activeMembers.slice(0, 6).map((w) => (
                            <Badge
                              key={w.id}
                              variant="secondary"
                              className="text-xs font-normal no-default-active-elevate"
                            >
                              {w.fullName}
                            </Badge>
                          ))}
                          {activeMembers.length > 6 && (
                            <Badge variant="outline" className="text-xs font-normal no-default-active-elevate">
                              +{activeMembers.length - 6} more
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      )}
    </>
  );
}
