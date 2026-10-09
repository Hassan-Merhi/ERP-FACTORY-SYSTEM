import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, type CartLine, type RetailLineDiscountType } from "./retailPosTypes";

export interface LineAdjustment {
  priceOverride: number | null;
  discountType: RetailLineDiscountType;
  discountValue: number;
  discountReason: string | null;
}

type Mode = "none" | "percent" | "fixed" | "override";

function modeOf(line: CartLine): Mode {
  if (line.priceOverride !== null && line.priceOverride !== undefined) return "override";
  if (line.discountType === "percent") return "percent";
  if (line.discountType === "fixed") return "fixed";
  return "none";
}

/**
 * Per-line discount / price override. The list price is never edited here — the dialog only
 * records what the cashier entered; the server snapshots original / discount / final price and
 * demands a reason (and manager approval above the company limit).
 */
export function RetailLineAdjustDialog({
  line,
  onClose,
  onApply,
}: {
  line: CartLine | null;
  onClose: () => void;
  onApply: (line: CartLine, adjustment: LineAdjustment) => void;
}) {
  const [mode, setMode] = useState<Mode>("none");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!line) return;
    setMode(modeOf(line));
    if (modeOf(line) === "override") setValue(String(line.priceOverride ?? ""));
    else if (line.discountType && line.discountType !== "none") setValue(String(line.discountValue ?? ""));
    else setValue("");
    setReason(line.discountReason ?? "");
  }, [line]);

  if (!line) return null;

  const numeric = Number(value);
  const validNumber = Number.isFinite(numeric) && numeric >= 0;
  const needsReason = mode !== "none";
  const invalid =
    (mode === "percent" && (!validNumber || numeric > 100)) ||
    (mode === "fixed" && (!validNumber || numeric > line.price)) ||
    (mode === "override" && (!validNumber || numeric <= 0)) ||
    (needsReason && !reason.trim());

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="retail-line-adjust">
        <DialogHeader>
          <DialogTitle>Line discount / price override</DialogTitle>
          <DialogDescription data-no-translate>
            {line.name} · {line.color} · {line.size} — list {money(line.price)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["none", "No discount"],
                ["percent", "Discount %"],
                ["fixed", "Discount per unit"],
                ["override", "Price override"],
              ] as Array<[Mode, string]>
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                variant={mode === key ? "default" : "outline"}
                size="sm"
                onClick={() => setMode(key)}
                data-testid={`retail-line-adjust-${key}`}
              >
                {label}
              </Button>
            ))}
          </div>
          {mode !== "none" && (
            <div>
              <Label htmlFor="retail-line-adjust-value">
                {mode === "percent" ? "Discount percent" : mode === "fixed" ? "Discount per unit" : "New unit price"}
              </Label>
              <Input
                id="retail-line-adjust-value"
                type="number"
                min="0"
                step="0.01"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                data-testid="retail-line-adjust-value"
              />
            </div>
          )}
          {mode !== "none" && (
            <div>
              <Label htmlFor="retail-line-adjust-reason">Reason (required)</Label>
              <Input
                id="retail-line-adjust-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why this discount is given"
                data-testid="retail-line-adjust-reason"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={invalid}
            onClick={() =>
              onApply(line, {
                priceOverride: mode === "override" ? numeric : null,
                discountType: mode === "percent" || mode === "fixed" ? mode : "none",
                discountValue: mode === "percent" || mode === "fixed" ? numeric : 0,
                discountReason: mode === "none" ? null : reason.trim(),
              })
            }
            data-testid="retail-line-adjust-apply"
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
