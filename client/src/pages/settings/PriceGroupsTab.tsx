import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin, Layers, Plus, Trash2, Save } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Location {
  id: number;
  name: string;
  code: string;
}

interface PriceGroup {
  masterLocationId: number;
  followerLocationIds: number[];
}

// Stable empty default: if the price-group request fails, `= []` would be a new
// array every render and the sync effect would call setGroups on each one.
const NO_SAVED_GROUPS: PriceGroup[] = [];

export function PriceGroupsTab() {
  const { toast } = useToast();
  const [groups, setGroups] = useState<PriceGroup[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data: locations = [], isLoading: locLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: savedGroups = NO_SAVED_GROUPS, isLoading: groupsLoading } = useQuery<PriceGroup[]>({
    queryKey: ["/api/location-price-groups"],
  });

  useEffect(() => {
    if (!groupsLoading && savedGroups) {
      setGroups(savedGroups);
      setDirty(false);
    }
  }, [savedGroups, groupsLoading]);

  const saveMutation = useMutation({
    mutationFn: async (g: PriceGroup[]) => {
      const res = await apiRequest("PUT", "/api/location-price-groups", { groups: g });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Failed to save" }));
        throw new Error(body.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/location-price-groups"] });
      setDirty(false);
      toast({ title: "Price groups saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addGroup = () => {
    setGroups((prev) => [...prev, { masterLocationId: 0, followerLocationIds: [] }]);
    setDirty(true);
  };

  const removeGroup = (idx: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const setMaster = (idx: number, locationId: number) => {
    setGroups((prev) =>
      prev.map((g, i) => (i === idx ? { ...g, masterLocationId: locationId, followerLocationIds: [] } : g))
    );
    setDirty(true);
  };

  const toggleFollower = (idx: number, locationId: number) => {
    setGroups((prev) =>
      prev.map((g, i) => {
        if (i !== idx) return g;
        const has = g.followerLocationIds.includes(locationId);
        return {
          ...g,
          followerLocationIds: has
            ? g.followerLocationIds.filter((id) => id !== locationId)
            : [...g.followerLocationIds, locationId],
        };
      })
    );
    setDirty(true);
  };

  const usedMasters = new Set(groups.map((g) => g.masterLocationId).filter(Boolean));

  if (locLoading || groupsLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Price Groups</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure master locations whose prices automatically cascade to their follower locations. The Price List will
          show one column per master location.
        </p>
      </div>

      <div className="space-y-4">
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
            No price groups configured. Add one below.
          </p>
        )}

        {groups.map((group, idx) => {
          const masterLoc = locations.find((l) => l.id === group.masterLocationId);
          const availableFollowers = locations.filter((l) => l.id !== group.masterLocationId && !usedMasters.has(l.id));
          const availableMasters = locations.filter((l) => !usedMasters.has(l.id) || l.id === group.masterLocationId);

          return (
            <div key={idx} className="border rounded-md p-4 space-y-3">
              <div className="flex items-center gap-2 justify-between flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">Master Location</span>
                  <Select
                    value={group.masterLocationId ? String(group.masterLocationId) : ""}
                    onValueChange={(v) => setMaster(idx, parseInt(v))}
                  >
                    <SelectTrigger data-testid={`select-master-location-${idx}`} className="w-48">
                      <SelectValue placeholder="Select master…" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableMasters.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  data-testid={`button-remove-group-${idx}`}
                  onClick={() => removeGroup(idx)}
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>

              {group.masterLocationId > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Select locations that will inherit prices from <strong>{masterLoc?.name}</strong>:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {availableFollowers.length === 0 && (
                      <span className="text-xs text-muted-foreground italic">No other locations available</span>
                    )}
                    {availableFollowers.map((l) => {
                      const selected = group.followerLocationIds.includes(l.id);
                      return (
                        <button
                          key={l.id}
                          data-testid={`toggle-follower-${idx}-${l.id}`}
                          onClick={() => toggleFollower(idx, l.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition-colors hover-elevate"
                          style={{
                            background: selected ? "hsl(var(--primary))" : undefined,
                            color: selected ? "hsl(var(--primary-foreground))" : undefined,
                          }}
                        >
                          <MapPin className="w-3 h-3" />
                          {l.name}
                        </button>
                      );
                    })}
                  </div>
                  {group.followerLocationIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Pricing for{" "}
                      <strong>
                        {group.followerLocationIds.length} location{group.followerLocationIds.length > 1 ? "s" : ""}
                      </strong>{" "}
                      will follow <strong>{masterLoc?.name}</strong>.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="button-add-price-group"
          onClick={addGroup}
          disabled={locations.length === 0}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Add Group
        </Button>

        {dirty && (
          <Button
            size="sm"
            data-testid="button-save-price-groups"
            onClick={() => saveMutation.mutate(groups)}
            disabled={saveMutation.isPending}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saveMutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        )}
      </div>
    </div>
  );
}
