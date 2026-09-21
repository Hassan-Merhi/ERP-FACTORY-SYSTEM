import { getErrorDetails } from "@shared/errorUtils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft,
  Check,
  RotateCcw,
  Ship,
  Truck,
  AlertTriangle,
  CheckCircle,
  Package,
  Trash2,
  Plus,
  Wrench,
  Pencil,
  X,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";

import type { ComparisonItem, FinalizePreview, OrderDetail, VerificationSummary } from "./pendinginvoiceverify/types";
import { PendingInvoiceDialogs } from "./pendinginvoiceverify/PendingInvoiceDialogs";
export default function PendingInvoiceVerify() {
  const { toast } = useToast();
  const { selectedCompany: _selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const params = useParams<{ id: string }>();
  const orderId = params.id;

  const [containerNumber, setContainerNumber] = useState("");
  const [shippingCompany, setShippingCompany] = useState("");
  const [containerNotes, setContainerNotes] = useState("");
  const [containerInitialized, setContainerInitialized] = useState(false);

  const [chargeName, setChargeName] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeType, setChargeType] = useState("FREIGHT");
  const [chargeLedgerAccountId, setChargeLedgerAccountId] = useState<string>("");

  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [approveNotes, setApproveNotes] = useState("");
  const [showFinalizePreview, setShowFinalizePreview] = useState(false);
  const [finalizePreview, setFinalizePreview] = useState<FinalizePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showFixBalesDialog, setShowFixBalesDialog] = useState(false);
  const [editingPrice, setEditingPrice] = useState<{ articleCode: string; value: string } | null>(null);

  const { data: verification, isLoading: verificationLoading } = useQuery<VerificationSummary>({
    queryKey: ["/api/factory/customer-orders", orderId, "verification"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/verification-summary`, {
        credentials: "include",
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Server error ${res.status} on verification-summary`);
      }
      return res.json();
    },
    enabled: !!orderId,
  });

  const { data: orderDetail, isLoading: orderLoading } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}`, { credentials: "include" });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Server error ${res.status} on order detail`);
      }
      return res.json();
    },
    enabled: !!orderId,
  });

  const { data: currentUser } = useQuery<{ role?: string }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });
  const _isAdminOrOwner =
    currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";
  const isDeveloper = currentUser?.role === "Developer";

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string; accountType: string }[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
  });

  useEffect(() => {
    if (orderDetail && !containerInitialized) {
      setContainerNumber(orderDetail.containerNumber || "");
      setShippingCompany(orderDetail.shippingCompany || "");
      setContainerNotes(orderDetail.containerNotes || "");
      setContainerInitialized(true);
    }
  }, [orderDetail, containerInitialized]);

  const verifyMutation = useMutation({
    mutationFn: async (data: { approved: boolean; notes?: string }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/verify`, data);
    },
    onSuccess: () => {
      toast({ title: "Order verified", description: "The order has been approved and verified" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const returnToLoadingMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/return-to-loading`);
    },
    onSuccess: () => {
      toast({ title: "Returned to loading", description: "The order has been returned for further loading" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignContainerMutation = useMutation({
    mutationFn: async (data: { containerNumber: string; shippingCompany: string; containerNotes: string }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/assign-container`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Container info saved" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addChargeMutation = useMutation({
    mutationFn: async (data: { name: string; amount: number; chargeType: string; ledgerAccountId?: number }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setChargeName("");
      setChargeAmount("");
      setChargeLedgerAccountId("");
      toast({ title: "Charge added" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeChargeMutation = useMutation({
    mutationFn: async (chargeId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Charge removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize`);
    },
    onSuccess: () => {
      toast({ title: "Invoice finalized", description: "Invoice has been created successfully" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      navigate(`/factory/sales/invoices/${orderId}`);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const forceSyncMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/force-sync-bale-status`);
    },
    onSuccess: () => {
      toast({ title: "Bales fixed", description: "Bale statuses have been set to SOLD" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId, "verification"] });
      setShowFixBalesDialog(false);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repriceArticleMutation = useMutation({
    mutationFn: async (data: { articleCode: string; pricePerBale: number }) => {
      await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/bales/reprice-article`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId, "verification"] });
      setEditingPrice(null);
      toast({ title: "Price updated", description: "Bale prices have been updated and totals recalculated" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSavePrice = (articleCode: string) => {
    if (!editingPrice || editingPrice.articleCode !== articleCode) return;
    const price = parseFloat(editingPrice.value);
    if (isNaN(price) || price < 0) {
      toast({ title: "Invalid price", description: "Please enter a valid price", variant: "destructive" });
      return;
    }
    repriceArticleMutation.mutate({ articleCode, pricePerBale: price });
  };

  const fetchFinalizePreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/finalize-preview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch preview");
      const data = await res.json();
      setFinalizePreview(data);
      setShowFinalizePreview(true);
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleAddCharge = () => {
    if (!chargeAmount || !orderId) return;
    const name = chargeType === "FREIGHT" ? "Freight" : chargeName.trim();
    if (!name) return;
    addChargeMutation.mutate({
      name,
      amount: parseFloat(chargeAmount),
      chargeType,
      ledgerAccountId: chargeLedgerAccountId ? parseInt(chargeLedgerAccountId) : undefined,
    });
  };

  const _getComparisonRowClass = (status: ComparisonItem["status"]) => {
    switch (status) {
      case "LOADED_NOT_IN_PROFORMA":
      case "MISSING_FROM_LOADED":
        return "status-danger";
      case "UNDER_LOADED":
        return "status-warning";
      case "OVER_LOADED":
        return "status-success";
      case "MATCH":
      default:
        return "";
    }
  };

  const getStatusBadge = (status: ComparisonItem["status"]) => {
    switch (status) {
      case "LOADED_NOT_IN_PROFORMA":
        return (
          <Badge variant="destructive" data-testid="badge-loaded-not-in-proforma">
            Not in Proforma
          </Badge>
        );
      case "MISSING_FROM_LOADED":
        return (
          <Badge variant="destructive" data-testid="badge-missing-from-loaded">
            Missing
          </Badge>
        );
      case "UNDER_LOADED":
        return (
          <Badge variant="outline" className="status-warning" data-testid="badge-under-loaded">
            Under Loaded
          </Badge>
        );
      case "OVER_LOADED":
        return (
          <Badge variant="outline" className="status-success" data-testid="badge-over-loaded">
            Over Loaded
          </Badge>
        );
      case "MATCH":
        return (
          <Badge variant="outline" className="status-success" data-testid="badge-match">
            <CheckCircle className="h-3 w-3 mr-1" />
            Match
          </Badge>
        );
      default:
        return null;
    }
  };

  const isLoading = verificationLoading || orderLoading;
  const charges = orderDetail?.charges || [];
  const orderStatus = verification?.order?.status || orderDetail?.status || "";
  const isPending = orderStatus === "PENDING_VERIFICATION";
  const isVerified = orderStatus === "VERIFIED";

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6">
        <Skeleton className="h-10 w-64 mb-4" />
        <div className="grid grid-cols-2 gap-4 mb-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 lg:p-6 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/factory/invoicing?tab=invoices")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Verify Order #{orderId}
            </h1>
            <p className="text-muted-foreground text-sm">Review loaded bales against proforma</p>
          </div>
        </div>
        <div>
          {isPending && (
            <Badge variant="outline" className="status-warning" data-testid="badge-order-status">
              Pending Verification
            </Badge>
          )}
          {isVerified && (
            <Badge variant="outline" className="status-success" data-testid="badge-order-status">
              Verified
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Loaded Bales</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-loaded-bales">
              {verification?.totalLoadedBales ?? 0} bales
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Weight</CardTitle>
            <Truck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-weight">
              {(verification?.totalLoadedWeight ?? 0).toFixed(2)} kg
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Proforma vs Loaded</CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            const comparisonMap = new Map<string, ComparisonItem>();
            (verification?.comparison || []).forEach((c) => comparisonMap.set(c.articleCode, c));
            const filteredProformaLines = (verification?.proformaLines || []).filter((line) => {
              const cmp = comparisonMap.get(line.articleCode);
              return !cmp || cmp.status !== "MATCH";
            });
            const getProformaRowClass = (articleCode: string) => {
              const cmp = comparisonMap.get(articleCode);
              if (!cmp) return "";
              if (cmp.status === "UNDER_LOADED" || cmp.status === "MISSING_FROM_LOADED") return "status-danger";
              if (cmp.status === "OVER_LOADED") return "status-success";
              return "";
            };

            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <h3 className="font-semibold text-sm mb-3" data-testid="text-proforma-header">
                    Proforma Expected <span className="text-muted-foreground font-normal">(mismatches only)</span>
                  </h3>
                  {filteredProformaLines.length > 0 ? (
                    <Table wrapperClassName="max-h-[50vh] overflow-auto">
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Article</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Expected</TableHead>
                          <TableHead className="text-right">Loaded</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredProformaLines.map((line, i) => {
                          const cmp = comparisonMap.get(line.articleCode);
                          return (
                            <TableRow
                              key={i}
                              className={getProformaRowClass(line.articleCode)}
                              data-testid={`row-proforma-${line.articleCode}`}
                            >
                              <TableCell
                                className="font-mono text-sm"
                                data-testid={`text-proforma-article-${line.articleCode}`}
                              >
                                {line.articleCode}
                              </TableCell>
                              <TableCell className="text-sm">{line.productName}</TableCell>
                              <TableCell className="text-right font-mono">{line.expectedQty}</TableCell>
                              <TableCell className="text-right font-mono">{cmp?.loadedQty ?? 0}</TableCell>
                              <TableCell>{cmp ? getStatusBadge(cmp.status) : null}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-proforma-mismatches">
                      All proforma items matched - no mismatches
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-sm mb-3" data-testid="text-loaded-header">
                    Loaded Bales
                  </h3>
                  {verification?.loadedItems && verification.loadedItems.length > 0 ? (
                    <Table wrapperClassName="max-h-[50vh] overflow-auto">
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Article</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Weight</TableHead>
                          <TableHead className="text-right">$/Bale</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {verification.loadedItems.map((group, i) => {
                          const isEditing = editingPrice?.articleCode === group.articleCode;
                          return (
                            <TableRow key={i} data-testid={`row-loaded-${group.articleCode}`}>
                              <TableCell
                                className="font-mono text-sm"
                                data-testid={`text-loaded-article-${group.articleCode}`}
                              >
                                {group.articleCode}
                              </TableCell>
                              <TableCell className="text-sm">{group.productName}</TableCell>
                              <TableCell className="text-right font-mono">{group.qty}</TableCell>
                              <TableCell className="text-right font-mono">
                                {(group.totalWeight || 0).toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right">
                                {isEditing ? (
                                  <div className="flex items-center justify-end gap-1">
                                    <Input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      className="w-24 h-7 text-right text-sm font-mono px-2"
                                      value={editingPrice!.value}
                                      onChange={(e) =>
                                        setEditingPrice({ articleCode: group.articleCode, value: e.target.value })
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSavePrice(group.articleCode);
                                        if (e.key === "Escape") setEditingPrice(null);
                                      }}
                                      autoFocus
                                      data-testid={`input-price-${group.articleCode}`}
                                    />
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      onClick={() => handleSavePrice(group.articleCode)}
                                      disabled={repriceArticleMutation.isPending}
                                      data-testid={`button-save-price-${group.articleCode}`}
                                    >
                                      <Check className="h-3 w-3 text-green-600" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      onClick={() => setEditingPrice(null)}
                                      data-testid={`button-cancel-price-${group.articleCode}`}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ) : (
                                  <div
                                    className="flex items-center justify-end gap-1 group cursor-pointer"
                                    onClick={() =>
                                      setEditingPrice({
                                        articleCode: group.articleCode,
                                        value: String(group.pricePerBale || "0"),
                                      })
                                    }
                                    data-testid={`cell-price-${group.articleCode}`}
                                  >
                                    <span className="font-mono text-sm">
                                      {parseFloat(group.pricePerBale || "0").toFixed(2)}
                                    </span>
                                    <Pencil className="h-3 w-3 text-muted-foreground invisible group-hover:visible" />
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {(group.totalPrice || 0).toFixed(2)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-loaded">
                      No loaded bales
                    </p>
                  )}
                </div>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {(() => {
        const comparison = verification?.comparison || [];
        const overloadedItems = comparison.filter((c) => c.status === "OVER_LOADED");
        const lessLoadedItems = comparison.filter(
          (c) => c.status === "UNDER_LOADED" || c.status === "MISSING_FROM_LOADED"
        );
        const loadedNotRequestedItems = comparison.filter((c) => c.status === "LOADED_NOT_IN_PROFORMA");
        const formatTotal = (item: ComparisonItem) => {
          const w = Number(item.totalWeight) || 0;
          const p = Number(item.totalPrice) || 0;
          if (w > 0 && p > 0)
            return (
              <>
                <div>{w.toFixed(2)} kg</div>
                <div className="text-muted-foreground text-xs">${p.toFixed(2)}</div>
              </>
            );
          if (w > 0) return <>{w.toFixed(2)} kg</>;
          if (p > 0) return <>${p.toFixed(2)}</>;
          return <>-</>;
        };

        const renderSummaryTable = (title: string, items: ComparisonItem[], colorClass: string, testId: string) => (
          <Card className="mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                {title} ({items.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {items.length > 0 ? (
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item, i) => (
                      <TableRow key={i} className={colorClass} data-testid={`row-${testId}-${item.articleCode}`}>
                        <TableCell>
                          <div className="text-sm font-medium">{item.productName}</div>
                          <div className="text-xs text-muted-foreground font-mono">{item.articleCode}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          <div>{item.loadedQty}</div>
                          {item.expectedQty > 0 && (
                            <div className="text-xs text-muted-foreground">(exp: {item.expectedQty})</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatTotal(item)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid={`text-none-${testId}`}>
                  None
                </p>
              )}
            </CardContent>
          </Card>
        );

        return (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Summary
            </h2>
            {renderSummaryTable("Overloaded", overloadedItems, "bg-green-50 dark:bg-green-950", "overloaded")}
            {renderSummaryTable("Less Loaded", lessLoadedItems, "bg-red-50 dark:bg-red-950", "less-loaded")}
            {renderSummaryTable(
              "Loaded Not Requested",
              loadedNotRequestedItems,
              "bg-red-50 dark:bg-red-950",
              "not-requested"
            )}
          </div>
        );
      })()}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Ship className="h-5 w-5" />
            Container / Shipping
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Container Number</label>
              <Input
                value={containerNumber}
                onChange={(e) => setContainerNumber(e.target.value)}
                placeholder="e.g. MSCU1234567"
                data-testid="input-container-number"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Shipping Company</label>
              <Input
                value={shippingCompany}
                onChange={(e) => setShippingCompany(e.target.value)}
                placeholder="e.g. MSC, Maersk"
                data-testid="input-shipping-company"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Container Notes</label>
            <Textarea
              value={containerNotes}
              onChange={(e) => setContainerNotes(e.target.value)}
              placeholder="Additional notes..."
              data-testid="input-container-notes"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => assignContainerMutation.mutate({ containerNumber, shippingCompany, containerNotes })}
            disabled={assignContainerMutation.isPending}
            data-testid="button-save-container"
          >
            <Ship className="mr-2 h-4 w-4" />
            Save Container Info
          </Button>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm">Freight &amp; Charges</CardTitle>
          <p className="text-xs text-muted-foreground">
            These will be billed to the customer and posted to the selected account
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {charges.length > 0 && (
            <div className="space-y-1">
              {charges.map((charge) => {
                const acct = ledgerAccounts.find((a) => a.id === charge.ledgerAccountId);
                return (
                  <div
                    key={charge.id}
                    className="flex items-center justify-between gap-2"
                    data-testid={`row-charge-${charge.id}`}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium">{charge.name}</span>
                      {acct && <span className="text-xs text-muted-foreground">{acct.name}</span>}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                        {parseFloat(charge.amount).toFixed(2)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeChargeMutation.mutate(charge.id)}
                        disabled={removeChargeMutation.isPending}
                        data-testid={`button-remove-charge-${charge.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground">Add Charge</p>
            <Select value={chargeType} onValueChange={setChargeType}>
              <SelectTrigger data-testid="select-charge-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FREIGHT">Freight</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>

            {chargeType === "OTHER" && (
              <Input
                value={chargeName}
                onChange={(e) => setChargeName(e.target.value)}
                placeholder="Charge name..."
                data-testid="input-charge-name"
              />
            )}

            <Select value={chargeLedgerAccountId} onValueChange={setChargeLedgerAccountId}>
              <SelectTrigger data-testid="select-charge-account">
                <SelectValue placeholder="Select account (optional)..." />
              </SelectTrigger>
              <SelectContent>
                {ledgerAccounts.map((acct) => (
                  <SelectItem key={acct.id} value={String(acct.id)} data-testid={`option-account-${acct.id}`}>
                    {acct.name} <span className="text-muted-foreground text-xs">({acct.code})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                value={chargeAmount}
                onChange={(e) => setChargeAmount(e.target.value)}
                placeholder="Amount"
                data-testid="input-charge-amount"
              />
              <Button
                variant="outline"
                onClick={handleAddCharge}
                disabled={!chargeAmount || addChargeMutation.isPending}
                data-testid="button-add-charge"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <Button
          variant="outline"
          onClick={() => setShowReturnDialog(true)}
          disabled={returnToLoadingMutation.isPending}
          data-testid="button-return-to-loading"
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          Return to Loading
        </Button>

        <div className="flex items-center gap-2">
          {isPending && (
            <Button
              onClick={() => setShowApproveDialog(true)}
              disabled={verifyMutation.isPending}
              data-testid="button-approve-verify"
            >
              <Check className="mr-2 h-4 w-4" />
              Approve & Verify
            </Button>
          )}
          {isVerified && isDeveloper && orderDetail?.invoiceNumber && (
            <Button
              variant="outline"
              onClick={() => setShowFixBalesDialog(true)}
              disabled={forceSyncMutation.isPending}
              data-testid="button-fix-bale-status"
            >
              <Wrench className="mr-2 h-4 w-4" />
              Fix Bale Statuses
            </Button>
          )}
          {isVerified && (
            <Button
              onClick={fetchFinalizePreview}
              disabled={finalizeMutation.isPending || previewLoading}
              data-testid="button-finalize-invoice"
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              Finalize Invoice
            </Button>
          )}
        </div>
      </div>

      <PendingInvoiceDialogs
        showApproveDialog={showApproveDialog}
        setShowApproveDialog={setShowApproveDialog}
        approveNotes={approveNotes}
        setApproveNotes={setApproveNotes}
        verifyPending={verifyMutation.isPending}
        onVerify={(notes) => verifyMutation.mutate({ approved: true, notes: notes || undefined })}
        showReturnDialog={showReturnDialog}
        setShowReturnDialog={setShowReturnDialog}
        returnPending={returnToLoadingMutation.isPending}
        onReturn={() => returnToLoadingMutation.mutate()}
        showFinalizePreview={showFinalizePreview}
        setShowFinalizePreview={setShowFinalizePreview}
        finalizePreview={finalizePreview}
        finalizePending={finalizeMutation.isPending}
        onFinalize={() => finalizeMutation.mutate()}
        showFixBalesDialog={showFixBalesDialog}
        setShowFixBalesDialog={setShowFixBalesDialog}
        onFixBales={() => forceSyncMutation.mutate()}
      />
    </div>
  );
}
