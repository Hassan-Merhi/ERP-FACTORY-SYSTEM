import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface MaterialRow {
  supplierId: string;
  kgAvailable: number;
  costPerKg: number;
}

interface OptimizeSuggestion {
  sources: { supplier: string; kgRatio: number }[];
  expectedCostPerBale: number;
  expectedProfit: number;
  historicalWastePercent: number;
}

interface BaleProduct {
  id: number;
  name: string;
}

interface Supplier {
  id: number;
  name: string;
}

export default function FactoryMixOptimizer() {
  const [targetProduct, setTargetProduct] = useState("");
  const [desiredMargin, setDesiredMargin] = useState(20);
  const [materials, setMaterials] = useState<MaterialRow[]>([{ supplierId: "", kgAvailable: 0, costPerKg: 0 }]);

  const productsQuery = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products?profile=picker"],
  });

  const suppliersQuery = useQuery<Supplier[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  const optimizeMutation = useMutation<OptimizeSuggestion[], Error>({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/mix/optimize", {
        targetProduct,
        desiredMargin,
        materials,
      });
      const data = await res.json();
      return data.suggestions || [];
    },
  });

  function addMaterial() {
    setMaterials((prev) => [...prev, { supplierId: "", kgAvailable: 0, costPerKg: 0 }]);
  }

  function removeMaterial(index: number) {
    setMaterials((prev) => prev.filter((_, i) => i !== index));
  }

  function updateMaterial(index: number, field: keyof MaterialRow, value: string | number) {
    setMaterials((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)));
  }

  function handleOptimize() {
    optimizeMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Mix Optimizer" subtitle="What-if calculator for optimizing bale mix ratios" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Optimization Parameters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="target-product">Target Product</Label>
              {productsQuery.isLoading ? (
                <div className="flex items-center gap-2" data-testid="loading-products">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Loading products...</span>
                </div>
              ) : (
                <Select value={targetProduct} onValueChange={setTargetProduct} data-testid="select-target-product">
                  <SelectTrigger data-testid="select-trigger-target-product">
                    <SelectValue placeholder="Select a product" />
                  </SelectTrigger>
                  <SelectContent>
                    {(productsQuery.data || []).map((product) => (
                      <SelectItem
                        key={product.id}
                        value={String(product.id)}
                        data-testid={`select-item-product-${product.id}`}
                      >
                        {product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="desired-margin">Desired Margin %</Label>
              <Input
                id="desired-margin"
                type="number"
                value={desiredMargin}
                onChange={(e) => setDesiredMargin(Number(e.target.value))}
                data-testid="input-desired-margin"
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Label className="text-base font-semibold">Available Materials</Label>
              <Button onClick={addMaterial} size="sm" data-testid="button-add-material">
                <Plus className="mr-1 h-4 w-4" />
                Add Material
              </Button>
            </div>

            {suppliersQuery.isLoading ? (
              <div className="flex items-center justify-center py-8" data-testid="loading-suppliers">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">Loading suppliers...</span>
              </div>
            ) : (
              <div className="space-y-3">
                {materials.map((mat, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end"
                    data-testid={`row-material-${idx}`}
                  >
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Supplier</Label>
                      <Select value={mat.supplierId} onValueChange={(val) => updateMaterial(idx, "supplierId", val)}>
                        <SelectTrigger data-testid={`select-trigger-supplier-${idx}`}>
                          <SelectValue placeholder="Select supplier" />
                        </SelectTrigger>
                        <SelectContent>
                          {(suppliersQuery.data || []).map((supplier) => (
                            <SelectItem
                              key={supplier.id}
                              value={String(supplier.id)}
                              data-testid={`select-item-supplier-${supplier.id}`}
                            >
                              {supplier.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">KG Available</Label>
                      <Input
                        type="number"
                        value={mat.kgAvailable}
                        onChange={(e) => updateMaterial(idx, "kgAvailable", Number(e.target.value))}
                        data-testid={`input-kg-available-${idx}`}
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Cost per KG</Label>
                      <Input
                        type="number"
                        value={mat.costPerKg}
                        onChange={(e) => updateMaterial(idx, "costPerKg", Number(e.target.value))}
                        data-testid={`input-cost-per-kg-${idx}`}
                      />
                    </div>

                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={() => removeMaterial(idx)}
                      disabled={materials.length <= 1}
                      data-testid={`button-remove-material-${idx}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button
            onClick={handleOptimize}
            disabled={optimizeMutation.isPending || !targetProduct}
            data-testid="button-optimize"
          >
            {optimizeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Optimize
          </Button>
        </CardContent>
      </Card>

      {optimizeMutation.isPending && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Calculating optimal mix...</span>
        </div>
      )}

      {optimizeMutation.isSuccess && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold" data-testid="text-results-title">
            Optimization Results
          </h2>

          {!Array.isArray(optimizeMutation.data) || optimizeMutation.data.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground" data-testid="text-no-suggestions">
                  No historical data available
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(Array.isArray(optimizeMutation.data) ? optimizeMutation.data : []).map((suggestion, idx) => (
                <Card key={idx} data-testid={`card-suggestion-${idx}`}>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-base">Suggestion {idx + 1}</CardTitle>
                    <Badge variant="outline" data-testid={`badge-waste-${idx}`}>
                      Waste: {suggestion.historicalWastePercent.toFixed(1)}%
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Sources</Label>
                      <ul className="mt-1 space-y-1">
                        {suggestion.sources.map((source, sIdx) => (
                          <li
                            key={sIdx}
                            className="flex items-center justify-between gap-2 text-sm"
                            data-testid={`text-source-${idx}-${sIdx}`}
                          >
                            <span>{source.supplier}</span>
                            <Badge variant="secondary" className="font-mono">
                              {source.kgRatio.toFixed(1)} KG
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                      <div>
                        <p className="text-xs text-muted-foreground">Expected Cost/Bale</p>
                        <p className="font-mono font-medium" data-testid={`text-cost-${idx}`}>
                          ${suggestion.expectedCostPerBale.toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Expected Profit</p>
                        <p
                          className="font-mono font-medium text-green-600 dark:text-green-400"
                          data-testid={`text-profit-${idx}`}
                        >
                          ${suggestion.expectedProfit.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {optimizeMutation.isError && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-red-600 dark:text-red-400" data-testid="text-error">
              {optimizeMutation.error?.message || "Failed to optimize mix"}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
