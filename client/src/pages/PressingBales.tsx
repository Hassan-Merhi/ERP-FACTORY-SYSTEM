import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Minus, Trash2, Printer, Barcode, ScanLine, AlertCircle, Package, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import type { FactoryBaleProduct } from "@shared/schema";

interface CartItem {
  productId: number;
  product: FactoryBaleProduct;
  qty: number;
  weightPerBaleKg: number;
}

function formatLabelNum(val: string | number): string {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return String(val);
  return n % 1 === 0 ? n.toFixed(0) : parseFloat(n.toFixed(3)).toString();
}

function generatePressingLabelHtml(
  labels: Array<{
    referenceNumber: string;
    articleCode: string;
    pieces: number;
    approxWeightKg: string;
    productName: string;
  }>
) {
  let labelsHtml = "";
  for (const label of labels) {
    labelsHtml += `
      <div class="label-page">
        <div class="code-label">
          <div class="label-top">
            <div class="logo-section">
              <div class="logo-text">HMD</div>
              <div class="logo-subtitle">INTERNATIONAL GROUP</div>
            </div>
            <div class="info-section">
              <div class="info-row"><span class="info-key">PIECES:</span> <span class="info-val">${formatLabelNum(label.pieces)}</span></div>
              <div class="info-row"><span class="info-key">ARTICLE:</span> <span class="info-val">${label.articleCode}</span></div>
              <div class="info-row"><span class="info-key">APRX WEIGHT:</span> <span class="info-val">${formatLabelNum(label.approxWeightKg)} KGS</span></div>
            </div>
          </div>
          <div class="barcode-area">
            <img class="barcode-img" src="/api/barcode/${encodeURIComponent(label.referenceNumber)}" alt="Barcode" />
            <div class="barcode-number">${label.referenceNumber}</div>
          </div>
        </div>
      </div>`;
  }
  return `<html><head><title>Pressing Labels</title><style>
    @page { size: 76mm 62mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; }
    .label-page { width: 76mm; height: 62mm; page-break-after: always; page-break-inside: avoid; break-inside: avoid; overflow: hidden; }
    .label-page:last-child { page-break-after: auto; }
    .code-label { width: 76mm; height: 62mm; padding: 2mm 3mm; display: flex; flex-direction: column; justify-content: space-between; background: #fff; }
    .label-top { display: flex; justify-content: space-between; align-items: flex-start; }
    .logo-section { display: flex; flex-direction: column; align-items: flex-start; }
    .logo-text { font-size: 18pt; font-weight: 900; letter-spacing: 2px; color: #000; line-height: 1; }
    .logo-subtitle { font-size: 5pt; font-weight: 700; letter-spacing: 1px; color: #000; margin-top: 0.5mm; }
    .info-section { text-align: right; font-size: 8pt; line-height: 1.4; }
    .info-key { font-weight: 900; }
    .info-val { font-weight: 900; }
    .barcode-area { text-align: center; margin-top: auto; flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .barcode-img { width: 100%; height: 16mm; object-fit: fill; }
    .barcode-number { font-size: 12pt; font-weight: 900; font-family: Arial, Helvetica, sans-serif; margin-top: 0.5mm; letter-spacing: 1.5px; }
    .product-short { font-size: 7pt; font-weight: 900; text-transform: uppercase; margin-top: 0.3mm; color: #000; white-space: nowrap; }
    .print-note { text-align: center; font-size: 9pt; color: #666; padding: 4px; background: #fffbe6; border-bottom: 1px solid #eee; }
    @media print { .print-note { display: none !important; } }
  </style></head><body><div class="print-note">Pressing labels - disable "Headers and Footers" in print settings for cleanest output.</div>${labelsHtml}</body></html>`;
}

export default function PressingBales() {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState("");
  const [pressDate, setPressDate] = useState(new Date().toLocaleDateString("en-CA"));
  const scanRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: baleProducts, isLoading: productsLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });

  const activeProducts = baleProducts?.filter((p) => p.active);

  useEffect(() => {
    if (scanRef.current) {
      scanRef.current.focus();
    }
  }, [cart]);

  const handleScan = (value: string) => {
    if (!value.trim()) return;
    setScanError("");

    const trimmed = value.trim().toLowerCase();
    const product = activeProducts?.find(
      (p) => p.articleCode?.toLowerCase() === trimmed || p.code.toLowerCase() === trimmed
    );

    if (!product) {
      setScanError(`Unknown product: "${value}"`);
      setScanInput("");
      return;
    }

    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;

    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id);
      if (existing) {
        return prev.map((item) => (item.productId === product.id ? { ...item, qty: item.qty + 1 } : item));
      }
      return [...prev, { productId: product.id, product, qty: 1, weightPerBaleKg: defaultWeight }];
    });

    setScanInput("");
  };

  const handleScanKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  const updateQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => (item.productId === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item))
        .filter((item) => item.qty > 0)
    );
  };

  const setQty = (productId: number, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((item) => item.productId !== productId));
    } else {
      setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, qty } : item)));
    }
  };

  const updateWeight = (productId: number, weight: number) => {
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, weightPerBaleKg: weight } : item)));
  };

  const removeItem = (productId: number) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
  };

  const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
  const totalKgToConsume = cart.reduce((sum, item) => sum + item.qty * item.weightPerBaleKg, 0);

  const printBaleLabels = async (
    bales: { id: number; productId?: number; weightKg?: string }[],
    products: FactoryBaleProduct[],
    weights: string[]
  ) => {
    try {
      const labelData = bales.map((bale, idx: number) => ({
        productionBaleId: bale.id,
        productId: products[idx].id,
        articleCode: products[idx].articleCode || products[idx].code,
        pieces: 1,
        approxWeightKg: weights[idx],
      }));

      const labelPrintResponse = await apiRequest("POST", "/api/bale-label-prints", {
        bales: labelData,
      });

      if (!labelPrintResponse.ok) {
        const err = await labelPrintResponse.json();
        throw new Error(err.message || "Failed to create label print records");
      }

      const { labelPrints } = (await labelPrintResponse.json()) as {
        labelPrints: Array<{
          referenceNumber: string;
          articleCode: string;
          pieces: number;
          approxWeightKg: string;
        }>;
      };

      const labels = labelPrints.map((lp, idx: number) => ({
        referenceNumber: lp.referenceNumber,
        articleCode: lp.articleCode,
        pieces: lp.pieces,
        approxWeightKg: lp.approxWeightKg,
        productName: products[idx]?.name || "",
      }));

      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        toast({ title: "Error", description: "Please allow pop-ups to print labels", variant: "destructive" });
        return;
      }

      printWindow.document.write(generatePressingLabelHtml(labels));
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 500);
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to generate labels",
        variant: "destructive",
      });
    }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (cart.length === 0) {
        throw new Error("Please add items to cart");
      }

      const items = cart.map((item) => ({
        productId: item.productId,
        quantity: item.qty,
        weightPerBale: item.weightPerBaleKg.toString(),
      }));

      const response = await apiRequest("POST", "/api/factory/pressing/create-multi", { items, txDate: pressDate });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to create bales");
      }

      const result = await response.json();

      const allProducts: FactoryBaleProduct[] = [];
      const allWeights: string[] = [];
      for (const bale of result.bales) {
        const cartItem = cart.find((c) => c.productId === bale.productId);
        allProducts.push(cartItem?.product || ({} as FactoryBaleProduct));
        allWeights.push(bale.weightKg || cartItem?.weightPerBaleKg.toString() || "25");
      }

      return { bales: result.bales, products: allProducts, weights: allWeights };
    },
    onSuccess: async ({ bales, products, weights }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/pressing-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });

      await printBaleLabels(bales, products, weights);

      toast({
        title: "Success",
        description: `Created ${bales.length} pressing bale(s) and sent to printer`,
      });

      setCart([]);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  if (productsLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" data-testid="text-loading" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <PageHeader title="Pressing Bales" subtitle="Scan products to create PENDING bales for counting" />
          </div>
          <Badge variant="secondary" data-testid="text-pressing-badge">
            PRESSING
          </Badge>
        </div>
      </div>

      <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Raw material usage is recorded at end of day during finalization — no mix batch needed at pressing time.
        </span>
      </div>

      <div className="flex gap-6">
        <div className="flex-1 min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <ScanLine className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Scan / Add Product</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Input
                  ref={scanRef}
                  value={scanInput}
                  onChange={(e) => {
                    setScanInput(e.target.value);
                    setScanError("");
                  }}
                  onKeyDown={handleScanKeyDown}
                  placeholder="Scan barcode or type article code..."
                  autoFocus
                  data-testid="input-scan"
                />
                {scanError && (
                  <div className="flex items-center gap-2 text-destructive text-sm" data-testid="text-scan-error">
                    <AlertCircle className="h-4 w-4" />
                    {scanError}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Cart ({totalQty} bales)</CardTitle>
            </CardHeader>
            <CardContent>
              {cart.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Barcode className="h-8 w-8 mx-auto mb-2" />
                  <p data-testid="text-empty-cart">Scan a product to add it to the cart</p>
                </div>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-center w-40">Qty</TableHead>
                      <TableHead className="text-right w-32">Wt/Bale (kg)</TableHead>
                      <TableHead className="text-right w-32">Total (kg)</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cart.map((item) => (
                      <TableRow key={item.productId} data-testid={`row-cart-${item.productId}`}>
                        <TableCell>
                          <div className="font-medium" data-testid={`text-product-name-${item.productId}`}>
                            {item.product.name}
                          </div>
                          <div className="text-sm text-muted-foreground font-mono">
                            {item.product.articleCode || item.product.code}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => updateQty(item.productId, -1)}
                              data-testid={`button-qty-minus-${item.productId}`}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <Input
                              type="number"
                              value={item.qty}
                              onChange={(e) => setQty(item.productId, parseInt(e.target.value) || 0)}
                              className="w-16 text-center"
                              min={1}
                              data-testid={`input-qty-${item.productId}`}
                            />
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => updateQty(item.productId, 1)}
                              data-testid={`button-qty-plus-${item.productId}`}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            value={item.weightPerBaleKg}
                            onChange={(e) => updateWeight(item.productId, parseFloat(e.target.value) || 0)}
                            className="w-24 text-right ml-auto"
                            step="0.1"
                            min={0}
                            data-testid={`input-weight-${item.productId}`}
                          />
                        </TableCell>
                        <TableCell className="text-right font-medium" data-testid={`text-total-kg-${item.productId}`}>
                          {formatNumber(item.qty * item.weightPerBaleKg)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeItem(item.productId)}
                            data-testid={`button-remove-${item.productId}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="w-72 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Production Total</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-sm text-muted-foreground">Total Bales</div>
                <div className="text-2xl font-bold" data-testid="text-total-bales">
                  {totalQty}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Total Weight</div>
                <div className="text-2xl font-bold" data-testid="text-total-weight">
                  {formatNumber(totalKgToConsume)} kg
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 space-y-1">
              <label className="text-sm font-medium">Press Date</label>
              <input
                type="date"
                value={pressDate}
                onChange={(e) => setPressDate(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-press-date"
              />
            </CardContent>
          </Card>

          <Button
            className="w-full gap-2"
            disabled={cart.length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="button-create-print"
          >
            <Printer className="h-4 w-4" />
            {createMutation.isPending ? "Creating..." : "Create + Print Pressing"}
          </Button>
        </div>
      </div>
    </div>
  );
}
