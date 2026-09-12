import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Link2, Trash2, Plus, Info } from "lucide-react";

interface SpAlias {
  id: number;
  alias_code?: string;
  stock_item_name?: string | null;
  stock_item_code?: string | null;
  stock_item_id?: number;
  description?: string | null;
}

export default function SpAliases() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [aliasCode, setAliasCode] = useState("");
  const [stockItemId, setStockItemId] = useState("");
  const [description, setDescription] = useState("");

  const { data: aliases = [], isLoading } = useQuery<SpAlias[]>({
    queryKey: ["/api/sp/aliases"],
  });

  const addMutation = useMutation({
    mutationFn: (body: { aliasCode: string; stockItemId: number; description?: string }) =>
      apiRequest("POST", "/api/sp/aliases", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/aliases"] });
      toast({ title: "Alias added" });
      setAliasCode("");
      setStockItemId("");
      setDescription("");
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/sp/aliases/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/aliases"] });
      toast({ title: "Alias removed" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleAdd = () => {
    if (!aliasCode.trim() || !stockItemId.trim()) {
      toast({ title: "Alias code and stock item ID required", variant: "destructive" });
      return;
    }
    const id = parseInt(stockItemId);
    if (isNaN(id) || id <= 0) {
      toast({ title: "Stock item ID must be a valid number", variant: "destructive" });
      return;
    }
    addMutation.mutate({ aliasCode: aliasCode.trim(), stockItemId: id, description: description.trim() || undefined });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Article Aliases</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Map supplier article codes to internal stock items for accurate FIFO tracking
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            How aliases work
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            When a sale is posted with an article code that has an alias, the server resolves it to the linked internal
            stock item and runs FIFO across all lots for that item — even if those lots were imported under different
            article codes. This is useful when a supplier changes their codes or uses different codes for the same
            product.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add Alias</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Supplier Article Code</label>
              <Input
                value={aliasCode}
                onChange={(e) => setAliasCode(e.target.value)}
                className="mt-1"
                placeholder="e.g. SUP-001"
                data-testid="input-sp-alias-code"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Internal Stock Item ID</label>
              <Input
                type="number"
                value={stockItemId}
                onChange={(e) => setStockItemId(e.target.value)}
                className="mt-1"
                placeholder="e.g. 42"
                data-testid="input-sp-alias-stock-item-id"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Description (optional)</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1"
                placeholder="Optional note"
                data-testid="input-sp-alias-desc"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={addMutation.isPending} size="sm" data-testid="button-sp-add-alias">
              {addMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5 mr-1" />
              )}
              Add Alias
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Current Aliases</h2>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : aliases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No aliases configured.</p>
        ) : (
          <Card>
            <CardContent className="py-3">
              <div className="overflow-x-auto">
                <div className="space-y-0.5 min-w-[480px]">
                  <div className="grid grid-cols-12 text-xs font-medium text-muted-foreground pb-1 border-b border-border/40">
                    <span className="col-span-3">Alias Code</span>
                    <span className="col-span-1 flex justify-center">
                      <Link2 className="h-3.5 w-3.5" />
                    </span>
                    <span className="col-span-3">Stock Item</span>
                    <span className="col-span-4">Description</span>
                    <span className="col-span-1"></span>
                  </div>
                  {aliases.map((a) => (
                    <div
                      key={a.id}
                      className="grid grid-cols-12 text-xs py-2 border-b border-border/30 last:border-0 items-center"
                      data-testid={`row-sp-alias-${a.id}`}
                    >
                      <span className="col-span-3 font-mono font-semibold">{a.alias_code}</span>
                      <span className="col-span-1 flex justify-center text-muted-foreground">→</span>
                      <div className="col-span-3">
                        {a.stock_item_name ? (
                          <>
                            <p className="font-medium">{a.stock_item_name}</p>
                            <p className="text-muted-foreground font-mono text-xs">
                              {a.stock_item_code} #{a.stock_item_id}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Item #{a.stock_item_id}</span>
                        )}
                      </div>
                      <span className="col-span-4 text-muted-foreground">{a.description || ""}</span>
                      <div className="col-span-1 flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteMutation.mutate(a.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-sp-delete-alias-${a.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
