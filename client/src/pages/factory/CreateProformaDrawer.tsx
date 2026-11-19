import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Save, Loader2, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateProformaDrawerModel } from "./CreateProformaDrawerModel";

const DRAFT_KEY = "create-proforma-draft-v2";

interface ArticleRow {
  articleCode: string;
  displayName: string;
  onHand: number;
  reservedNotYetLoaded: number;
  inLoading: number;
  freeToPromise: number;
}

export interface FactoryCustomer {
  id: number;
  legalName: string;
}

export interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  weightPerBaleKg: string | null;
  sellingPrice: string | null;
  productionPrice: string | null;
}

export interface Props {
  open: boolean;
  onClose: () => void;
  articleRows: ArticleRow[];
  onSuccess: () => void;
}

export interface Draft {
  customerId: string;
  proformaName: string;
  destination: string;
  isActive: boolean;
  quantities: Record<string, string>;
  sellingPrices: Record<string, string>;
  productionPrices: Record<string, string>;
  savedAt: number;
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function saveDraft(d: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
}
export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
}

export default function CreateProformaDrawer({ open, onClose, articleRows, onSuccess }: Props) {
  const m = useCreateProformaDrawerModel({ open, onClose, articleRows, onSuccess });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="max-w-[98vw] w-[98vw] h-[85dvh] sm:h-[96dvh] flex flex-col p-0 gap-0"
        data-testid="dialog-create-proforma"
      >
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="text-base">Create Proforma from Stock Allocation</DialogTitle>
        </DialogHeader>

        {/* Top fields row */}
        <div className="px-5 py-3 border-b shrink-0 flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
            <Label htmlFor="proforma-customer" className="text-xs font-medium">
              Customer <span className="text-destructive">*</span>
            </Label>
            <Select
              value={m.customerId}
              onValueChange={(v) => {
                m.setCustomerId(v);
                m.setErrors((p) => {
                  const n = { ...p };
                  delete n.customerId;
                  return n;
                });
              }}
            >
              <SelectTrigger
                id="proforma-customer"
                data-testid="select-proforma-customer"
                className={cn(m.errors.customerId && "border-destructive")}
              >
                <SelectValue placeholder="Select customer…" />
              </SelectTrigger>
              <SelectContent>
                {m.customersQuery.isLoading && (
                  <SelectItem value="__loading" disabled>
                    Loading…
                  </SelectItem>
                )}
                {(m.customersQuery.data || []).map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.legalName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {m.errors.customerId && <p className="text-xs text-destructive">{m.errors.customerId}</p>}
          </div>

          <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
            <Label htmlFor="proforma-name" className="text-xs font-medium">
              Proforma Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="proforma-name"
              data-testid="input-proforma-name"
              value={m.proformaName}
              onChange={(e) => {
                m.setProformaName(e.target.value);
                m.setErrors((p) => {
                  const n = { ...p };
                  delete n.proformaName;
                  return n;
                });
              }}
              placeholder="e.g. Proforma #001"
              className={cn(m.errors.proformaName && "border-destructive")}
            />
            {m.errors.proformaName && <p className="text-xs text-destructive">{m.errors.proformaName}</p>}
          </div>

          <div className="flex flex-col gap-1.5 min-w-[190px] flex-1">
            <Label htmlFor="proforma-destination" className="text-xs font-medium">
              Destination <span className="text-destructive">*</span>
            </Label>
            <Input
              id="proforma-destination"
              value={m.destination}
              onChange={(e) => m.setDestination(e.target.value)}
              placeholder="e.g. L'SHI, MALI, KINSHASA"
              list="v2-proforma-destinations"
              data-testid="input-proforma-destination-v2"
            />
            <datalist id="v2-proforma-destinations">
              <option value="L'SHI" />
              <option value="MALI" />
              <option value="KINSHASA" />
            </datalist>
            {m.errors.destination && <p className="text-xs text-destructive">{m.errors.destination}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium">Status</Label>
            <div className="flex items-center gap-2 h-9">
              <Switch checked={m.isActive} onCheckedChange={m.setIsActive} data-testid="switch-proforma-active" />
              <span className="text-sm text-muted-foreground">{m.isActive ? "Active" : "Inactive"}</span>
            </div>
          </div>

          {/* Global pricing controls */}
          <div className="flex items-center gap-2 border-l pl-4">
            <Button
              size="default"
              variant="outline"
              onClick={m.applyCatalogSellingPrice}
              data-testid="button-apply-selling-price"
            >
              Apply Sell Price
            </Button>
            <Button
              size="default"
              variant="outline"
              onClick={m.applyCatalogProductionPrice}
              data-testid="button-apply-production-price"
            >
              Apply Prod Price
            </Button>
          </div>

          {m.zeroItemCount > 0 && (
            <div className="border-l pl-4">
              <Button
                size="default"
                variant={m.showZeroItems ? "secondary" : "outline"}
                onClick={() => m.setShowZeroItems((v) => !v)}
                data-testid="button-toggle-zero-items"
              >
                {m.showZeroItems ? `Hide 0-bale (${m.zeroItemCount})` : `Show 0-bale (${m.zeroItemCount})`}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground h-9 ml-auto">
            {m.draftStatus === "saved" && (
              <>
                <CheckCircle className="h-3 w-3 text-green-500" />
                Draft autosaved
              </>
            )}
          </div>
        </div>

        {m.errors.lines && (
          <div className="px-5 py-2 bg-destructive/10 border-b shrink-0">
            <p className="text-xs text-destructive">{m.errors.lines}</p>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse min-w-max">
            <thead>
              <tr className="bg-muted sticky top-0 z-30">
                <th className="text-left px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[200px] sticky left-0 bg-muted z-20">
                  Product
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[72px]">
                  On Hand
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[80px] text-amber-600 dark:text-amber-400">
                  Reserved
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[85px] text-blue-600 dark:text-blue-400">
                  In Loading
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[95px] text-green-700 dark:text-green-400">
                  Free to Promise
                </th>
                <th className="text-center px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[110px]">
                  Qty
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[90px] text-muted-foreground">
                  Total KG
                </th>
                <th className="text-center px-3 py-2 font-medium border-b whitespace-nowrap min-w-[130px]">Price</th>
              </tr>
            </thead>
            <tbody>
              {m.visibleRows.map((row, idx) => {
                const rawVal = m.quantities[row.articleCode] ?? "";
                const parsed = parseInt(rawVal);
                const qty = isNaN(parsed) ? 0 : parsed;
                const overFtp = qty > 0 && qty > row.freeToPromise;
                const overBy = qty - row.freeToPromise;
                const hasError = !!m.errors[`qty_${row.articleCode}`];
                const product = m.map.get(row.articleCode);
                const weightPerBale = parseFloat(product?.weightPerBaleKg || "0");
                const totalRowKg = qty > 0 && weightPerBale > 0 ? qty * weightPerBale : null;

                return (
                  <tr
                    key={row.articleCode}
                    className={cn(
                      "border-b transition-colors",
                      idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                      qty > 0 && "bg-blue-50/30 dark:bg-blue-950/20"
                    )}
                    data-testid={`row-create-${row.articleCode}`}
                  >
                    {/* Product */}
                    <td className="px-3 py-1.5 border-r sticky left-0 bg-inherit z-10">
                      <div className="font-medium truncate max-w-[220px] text-xs leading-tight" title={row.displayName}>
                        {row.displayName}
                      </div>
                      {row.displayName !== row.articleCode && (
                        <div className="text-[11px] text-muted-foreground font-mono">{row.articleCode}</div>
                      )}
                    </td>

                    {/* On Hand */}
                    <td className="px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs">{row.onHand}</td>

                    {/* Reserved */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs",
                        row.reservedNotYetLoaded > 0 && "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {row.reservedNotYetLoaded > 0 ? (
                        row.reservedNotYetLoaded
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* In Loading */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs",
                        row.inLoading > 0 && "text-blue-600 dark:text-blue-400"
                      )}
                    >
                      {row.inLoading > 0 ? row.inLoading : <span className="text-muted-foreground/40">—</span>}
                    </td>

                    {/* FTP */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs font-semibold",
                        row.freeToPromise > 0
                          ? "text-green-700 dark:text-green-400"
                          : row.freeToPromise === 0
                            ? "text-muted-foreground"
                            : "text-destructive"
                      )}
                    >
                      {row.freeToPromise}
                    </td>

                    {/* Qty */}
                    <td className="px-2 py-1 border-r">
                      <div className="flex flex-col gap-0.5 items-center">
                        <Input
                          ref={(el) => {
                            m.qtyRefs.current[idx] = el;
                          }}
                          type="number"
                          min={0}
                          value={rawVal}
                          onChange={(e) => m.handleQtyChange(row.articleCode, e.target.value)}
                          onKeyDown={(e) => m.handleQtyKeyDown(e, idx)}
                          onFocus={(e) => e.target.select()}
                          placeholder="0"
                          className={cn(
                            "h-7 text-center text-xs font-mono w-20 px-1 tabular-nums",
                            hasError && "border-destructive",
                            overFtp && !hasError && "border-amber-400 dark:border-amber-500",
                            qty > 0 && !overFtp && !hasError && "border-blue-400 dark:border-blue-500"
                          )}
                          data-testid={`input-qty-${row.articleCode}`}
                        />
                        {hasError && (
                          <span className="text-[11px] text-destructive">{m.errors[`qty_${row.articleCode}`]}</span>
                        )}
                        {overFtp && !hasError && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                            <AlertTriangle className="h-2.5 w-2.5" />+{overBy} over FTP
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Total KG */}
                    <td className="px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs text-muted-foreground">
                      {totalRowKg != null ? (
                        <span className="text-foreground font-medium">
                          {totalRowKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* Price (selling or production, depending on which Apply button was used) */}
                    <td className="px-2 py-1">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={m.sellingPrices[row.articleCode] ?? ""}
                        onChange={(e) => m.setSellingPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        placeholder="0.00"
                        className="h-7 text-right text-xs font-mono w-24 px-2 tabular-nums"
                        data-testid={`input-price-${row.articleCode}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-muted/30 shrink-0 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <span>
              <span className="font-semibold text-foreground">{m.filledLines}</span> line
              {m.filledLines !== 1 ? "s" : ""}
            </span>
            <span>
              <span className="font-semibold text-foreground">{m.totalQty}</span> total bales
            </span>
            {m.totalKg > 0 && (
              <span>
                <span className="font-semibold text-foreground">
                  {m.totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </span>{" "}
                kg
              </span>
            )}
            {m.warningCount > 0 && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {m.warningCount} over Free to Promise
              </span>
            )}
            <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="default" onClick={onClose} data-testid="button-cancel-proforma">
              Cancel
            </Button>
            <Button
              size="default"
              onClick={m.handleSubmit}
              disabled={m.createMutation.isPending}
              data-testid="button-create-proforma-submit"
            >
              {m.createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Create Proforma
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
