import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, MapPin, RefreshCw, Save, Search, Truck } from "lucide-react";

interface TrackingDefaultSupplier {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  locationId: number | null;
  agentName: string | null;
  shopName: string | null;
  dutyFee: string | null;
}

interface TrackingLocation {
  id: number;
  code: string;
  name: string;
}

interface TrackingDefaultsResponse {
  suppliers: TrackingDefaultSupplier[];
  locations: TrackingLocation[];
  agentOptions: string[];
}

interface DraftValue {
  shopName: string;
  agentName: string;
  dutyFee: string;
}

function toDraft(row: TrackingDefaultSupplier): DraftValue {
  return {
    shopName: row.shopName ?? "",
    agentName: row.agentName ?? "",
    dutyFee: row.dutyFee ?? "",
  };
}

export function SupplierTrackingDefaultsTab({ canManage = false }: { canManage?: boolean }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<number, DraftValue>>({});
  const [savingSupplierId, setSavingSupplierId] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery<TrackingDefaultsResponse>({
    queryKey: ["/api/tracking-defaults/suppliers"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/tracking-defaults/suppliers");
      return (await res.json()) as TrackingDefaultsResponse;
    },
  });

  useEffect(() => {
    if (!data) return;
    setDrafts((current) =>
      Object.fromEntries(data.suppliers.map((row) => [row.supplierId, current[row.supplierId] ?? toDraft(row)]))
    );
  }, [data]);

  const filteredSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data?.suppliers ?? [];
    return (data?.suppliers ?? []).filter(
      (row) => row.supplierName.toLowerCase().includes(q) || row.supplierCode.toLowerCase().includes(q)
    );
  }, [data?.suppliers, search]);

  const saveMutation = useMutation({
    mutationFn: async ({ supplierId, draft }: { supplierId: number; draft: DraftValue }) => {
      setSavingSupplierId(supplierId);
      const res = await apiRequest("PUT", `/api/tracking-defaults/suppliers/${supplierId}`, {
        locationId: null,
        shopName: draft.shopName.trim() || null,
        agentName: draft.agentName.trim() || null,
        dutyFee: draft.dutyFee.trim() || null,
      });
      return await res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/tracking-defaults/suppliers"] });
      toast({
        title: "Tracking default saved",
        description: "New containers will use this supplier mapping automatically.",
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Could not save tracking default", description: error.message, variant: "destructive" });
    },
    onSettled: () => setSavingSupplierId(null),
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tracking-defaults/backfill", {});
      return (await res.json()) as { containersUpdated: number; shopsFilled: number; agentsFilled: number; dutiesFilled: number };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/git/containers"] });
      toast({
        title: "Blank tracking fields backfilled",
        description: `${result.containersUpdated} container(s) updated · ${result.shopsFilled} shop name(s) · ${result.agentsFilled} agent(s) · ${result.dutiesFilled} duty fee(s).`,
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Backfill failed", description: error.message, variant: "destructive" });
    },
  });

  const hasChanged = (row: TrackingDefaultSupplier) => {
    const draft = drafts[row.supplierId] ?? toDraft(row);
    const original = toDraft(row);
    return draft.shopName.trim() !== original.shopName.trim() ||
      draft.agentName.trim() !== original.agentName.trim() ||
      draft.dutyFee.trim() !== original.dutyFee.trim();
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold sm:text-xl">Supplier Tracking Defaults</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter a default Shop Name, clearing agent and Duty Fee for each supplier. New containers get these
          values in Tracking only when the corresponding field is blank; imported or manually entered values are kept.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Supplier mappings</CardTitle>
              <CardDescription>
                Mappings are company-specific and do not rewrite existing container history.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search suppliers..."
                className="pl-9"
                data-testid="input-search-supplier-tracking-defaults"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading supplier mappings…
            </div>
          ) : isError ? (
            <div className="py-8 text-sm text-destructive">Could not load supplier tracking defaults.</div>
          ) : filteredSuppliers.length === 0 ? (
            <div className="py-8 text-sm text-muted-foreground">No matching suppliers found.</div>
          ) : (
            <div className="space-y-3">
              {filteredSuppliers.map((row) => {
                const draft = drafts[row.supplierId] ?? toDraft(row);
                const changed = hasChanged(row);
                return (
                  <div
                    key={row.supplierId}
                    className="grid gap-3 rounded-lg border p-3 md:grid-cols-2 lg:grid-cols-[minmax(160px,1.2fr)_minmax(150px,1fr)_minmax(130px,0.9fr)_minmax(125px,0.8fr)_auto] lg:items-end"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{row.supplierName}</span>
                        <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                          {row.supplierCode}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">Supplier #{row.supplierId}</p>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Default Shop Name</Label>
                      <Input
                        value={draft.shopName}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.supplierId]: { ...draft, shopName: event.target.value },
                          }))
                        }
                        placeholder="Enter shop name"
                        maxLength={255}
                        disabled={!canManage}
                        data-testid={`input-tracking-shop-${row.supplierId}`}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Default Agent</Label>
                      <Input
                        value={draft.agentName}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.supplierId]: { ...draft, agentName: event.target.value },
                          }))
                        }
                        placeholder="e.g. NAHLI"
                        list="tracking-agent-options"
                        disabled={!canManage}
                        data-testid={`input-tracking-agent-${row.supplierId}`}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Default Duty Fee</Label>
                      <Input
                        value={draft.dutyFee}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [row.supplierId]: { ...draft, dutyFee: event.target.value },
                          }))
                        }
                        inputMode="decimal"
                        placeholder="e.g. 48.31"
                        disabled={!canManage}
                        data-testid={`input-tracking-duty-${row.supplierId}`}
                      />
                    </div>

                    <Button
                      size="sm"
                      onClick={() => saveMutation.mutate({ supplierId: row.supplierId, draft })}
                      disabled={!canManage || !changed || saveMutation.isPending}
                      data-testid={`button-save-tracking-default-${row.supplierId}`}
                    >
                      {savingSupplierId === row.supplierId ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Save
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <datalist id="tracking-agent-options">
            {(data?.agentOptions ?? []).map((agent) => (
              <option key={agent} value={agent} />
            ))}
          </datalist>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <Truck className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Existing containers</CardTitle>
              <CardDescription>
                Fill only blank Shop Name, Agent and Duty Fee fields using the mappings above. Existing values,
                including a manually entered 0 duty, are never changed.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => backfillMutation.mutate()}
            disabled={!canManage || backfillMutation.isPending}
            data-testid="button-backfill-supplier-tracking-defaults"
          >
            {backfillMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Fill blank fields on existing containers
          </Button>
          {!canManage && (
            <p className="mt-2 text-xs text-muted-foreground">Admin, Owner, or Developer access is required.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
