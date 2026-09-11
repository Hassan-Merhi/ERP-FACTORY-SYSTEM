import { Printer, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import { AdminAuthDialog } from "@/components/AdminAuthDialog";
import type { FactoryBaleProduct, FactoryCategory } from "@shared/schema";
import type { A4DesignColor } from "@/lib/labelHtml";

interface CartItem {
  productId: number;
  product: FactoryBaleProduct;
  qty: number;
  weightPerBaleKg: number;
  finalizedBy: number | null;
  overrideLogoId: number | null;
}

export function ConfirmStockEntryDialog({
  open,
  onOpenChange,
  cart,
  entryDate,
  totalQty,
  totalKg,
  selectedLogoId,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cart: CartItem[];
  entryDate: string;
  totalQty: number;
  totalKg: number;
  selectedLogoId: number | null;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Confirm Stock Entry</DialogTitle>
          <DialogDescription>
            {totalQty} bale(s) will be entered into stock. Labels ({getPaperFormat()} format) and sticker labels will
            print for each bale.
          </DialogDescription>
        </DialogHeader>
        <div className="text-sm space-y-3 overflow-y-auto flex-1 pr-1">
          {entryDate !== new Date().toLocaleDateString("en-CA") && (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-amber-800 dark:text-amber-200 text-xs">
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              <span>
                Backdated entry — will be recorded on <strong>{entryDate}</strong>
              </span>
            </div>
          )}
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-center">Qty</TableHead>
                <TableHead className="text-right">Wt/Bale</TableHead>
                <TableHead className="text-right">Total KG</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cart.map((item) => (
                <TableRow key={item.productId}>
                  <TableCell>
                    <div className="font-medium">{item.product?.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {item.product?.articleCode || item.product?.code}
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-medium">{item.qty}</TableCell>
                  <TableCell className="text-right">{formatNumber(item.weightPerBaleKg)} kg</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatNumber(item.qty * item.weightPerBaleKg)} kg
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t pt-2 flex justify-between items-center font-semibold">
            <span>Total: {totalQty} bales</span>
            <span>{formatNumber(totalKg)} kg</span>
          </div>
          {selectedLogoId && (
            <div className="border-t pt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <img
                src={`/api/factory/customer-logos/${selectedLogoId}/image`}
                alt="Selected logo"
                className="h-6 w-10 object-contain rounded"
              />
              <span>Custom logo will be used on labels</span>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending} data-testid="button-dialog-confirm-entry">
            <Printer className="h-4 w-4 mr-2" />
            {isPending ? "Processing..." : "Enter Stock & Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuickCreateProductDialog({
  open,
  onOpenChange,
  grade,
  onGradeChange,
  name,
  onNameChange,
  categoryId,
  onCategoryChange,
  weight,
  onWeightChange,
  activeCategories,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grade: string;
  onGradeChange: (val: string) => void;
  name: string;
  onNameChange: (val: string) => void;
  categoryId: string;
  onCategoryChange: (val: string) => void;
  weight: string;
  onWeightChange: (val: string) => void;
  activeCategories: FactoryCategory[];
  isPending: boolean;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quick Create Product</DialogTitle>
          <DialogDescription>Select the grade to auto-generate the article code.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quick-create-grade">Grade</Label>
            <Select value={grade} onValueChange={onGradeChange}>
              <SelectTrigger data-testid="select-quick-create-grade">
                <SelectValue placeholder="Select grade..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="#1">#1 (HMD11...)</SelectItem>
                <SelectItem value="#2">#2 (HMD12...)</SelectItem>
                <SelectItem value="#3">#3 (HMD13...)</SelectItem>
                <SelectItem value="#4">#4 (HMD14...)</SelectItem>
                <SelectItem value="CREAM">CREAM (HMD10...)</SelectItem>
                <SelectItem value="Garbage">Garbage (HMD16...)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-create-name">Name</Label>
            <Input
              id="quick-create-name"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Product name..."
              data-testid="input-quick-create-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-create-category">Category</Label>
            <Select value={categoryId} onValueChange={onCategoryChange}>
              <SelectTrigger data-testid="select-quick-create-category">
                <SelectValue placeholder="Select category..." />
              </SelectTrigger>
              <SelectContent>
                {activeCategories?.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id.toString()}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-create-weight">Weight per Bale (kg)</Label>
            <Input
              id="quick-create-weight"
              type="number"
              value={weight}
              onChange={(e) => onWeightChange(e.target.value)}
              placeholder="Optional - leave empty for default"
              step="0.1"
              min={0}
              data-testid="input-quick-create-weight"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={!name.trim() || !grade || isPending}
            data-testid="button-quick-create-submit"
          >
            {isPending ? "Creating..." : "Create & Add to Cart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DesignPickerDialog({
  open,
  onOpenChange,
  designColors,
  onSelect,
  onNoDesign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  designColors: { label: string; value: A4DesignColor; previewUrl: string }[];
  onSelect: (color: A4DesignColor) => void;
  onNoDesign: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose Label Design</DialogTitle>
          <DialogDescription>Select a brand color for the A4 label header banner.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          {designColors.map((opt) => (
            <button
              key={opt.value}
              data-testid={`button-design-${opt.value}`}
              className="flex flex-col items-center gap-2 p-3 rounded-md border hover-elevate cursor-pointer"
              onClick={() => onSelect(opt.value)}
            >
              <img src={opt.previewUrl} className="w-full h-16 rounded-md object-cover" alt={opt.label} />
              <span className="text-sm font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="secondary" data-testid="button-design-none" onClick={onNoDesign}>
            No Design
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { AdminAuthDialog };
