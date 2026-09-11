import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Plus, Check, ChevronsUpDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";

interface SupplierOption {
  id: number;
  name: string;
}

interface OpeningBalancePayload {
  supplierName: string;
  supplierId?: number;
  receivedKg: string;
  costPerKg: string;
  currencyCode: string;
  fxRateToUsd: string;
  notes?: string;
  txDate?: string;
  commissionAmount?: string;
  commissionCurrencyCode?: string;
  commissionFxRateToUsd?: string;
}

interface MutationLike<TVars> {
  isPending: boolean;
  mutate: (vars: TVars) => void;
}

interface OpeningBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  factorySuppliers: SupplierOption[];
  openingBalanceMutation: MutationLike<OpeningBalancePayload>;
  wrapAdminAction: (action: () => void, title: string) => void;
}

export function OpeningBalanceDialog({
  open,
  onOpenChange,
  factorySuppliers,
  openingBalanceMutation,
  wrapAdminAction,
}: OpeningBalanceDialogProps) {
  const { toast } = useToast();
  const [obSupplierName, setObSupplierName] = useState("");
  const [obSupplierId, setObSupplierId] = useState<number | null>(null);
  const [obSupplierOpen, setObSupplierOpen] = useState(false);
  const [obSupplierSearch, setObSupplierSearch] = useState("");
  const [obReceivedKg, setObReceivedKg] = useState("");
  const [obCostPerKg, setObCostPerKg] = useState("");
  const [obCurrency, setObCurrency] = useState("USD");
  const [obFxRate, setObFxRate] = useState("1");
  const [obNotes, setObNotes] = useState("");
  const [obCommissionAmount, setObCommissionAmount] = useState("");
  const [obCommissionCurrency, setObCommissionCurrency] = useState("USD");
  const [obCommissionFxRate, setObCommissionFxRate] = useState("1");
  const [obTxDate, setObTxDate] = useState(() => new Date().toLocaleDateString("en-CA"));

  const obKg = parseFloat(obReceivedKg || "0");
  const obRate = parseFloat(obCostPerKg || "0");
  const obFxRateNum = parseFloat(obFxRate || "1");
  const obRateUsd = obCurrency === "USD" ? obRate : obRate * obFxRateNum;
  const obTotal = obKg * obRate;
  const obTotalUsd = obKg * obRateUsd;

  const handleSubmit = () => {
    if (!obSupplierName.trim()) {
      toast({ title: "Missing fields", description: "Please enter a supplier name", variant: "destructive" });
      return;
    }
    if (obKg <= 0) {
      toast({ title: "Missing weight", description: "Please enter the weight in KG", variant: "destructive" });
      return;
    }
    if (obRate < 0) {
      toast({ title: "Missing cost", description: "Please enter the cost per KG", variant: "destructive" });
      return;
    }

    const commAmt = parseFloat(obCommissionAmount || "0");
    openingBalanceMutation.mutate({
      supplierName: obSupplierName.trim(),
      supplierId: obSupplierId || undefined,
      receivedKg: obReceivedKg,
      costPerKg: obCostPerKg,
      currencyCode: obCurrency,
      fxRateToUsd: obFxRate,
      notes: obNotes || undefined,
      txDate: obTxDate || undefined,
      ...(commAmt > 0
        ? {
            commissionAmount: obCommissionAmount,
            commissionCurrencyCode: obCommissionCurrency,
            commissionFxRateToUsd: obCommissionFxRate,
          }
        : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Opening Balance Stock</DialogTitle>
          <DialogDescription>
            Register raw material that is already in stock but was not offloaded from a container in this system.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Supplier / Broker</Label>
            <Popover open={obSupplierOpen} onOpenChange={setObSupplierOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={obSupplierOpen}
                  className="w-full justify-between"
                  data-testid="button-select-ob-supplier"
                >
                  {obSupplierName || "Select or search supplier..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0">
                <Command>
                  <CommandInput
                    placeholder="Search supplier..."
                    value={obSupplierSearch}
                    onValueChange={setObSupplierSearch}
                  />
                  <CommandList>
                    <CommandEmpty>No supplier found.</CommandEmpty>
                    <CommandGroup heading="Existing Suppliers">
                      {(factorySuppliers ?? []).map((s) => (
                        <CommandItem
                          key={s.id}
                          value={s.name}
                          onSelect={() => {
                            setObSupplierName(s.name);
                            setObSupplierId(s.id);
                            setObSupplierSearch("");
                            setObSupplierOpen(false);
                          }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", obSupplierId === s.id ? "opacity-100" : "opacity-0")} />
                          {s.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                    <CommandGroup heading="Actions">
                      {obSupplierSearch.trim() &&
                        !(factorySuppliers ?? []).some(
                          (s) => s.name.toLowerCase() === obSupplierSearch.toLowerCase().trim()
                        ) && (
                          <CommandItem
                            value={`__create__${obSupplierSearch}`}
                            onSelect={() => {
                              setObSupplierName(obSupplierSearch.trim());
                              setObSupplierId(null);
                              setObSupplierSearch("");
                              setObSupplierOpen(false);
                            }}
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            Create &ldquo;{obSupplierSearch.trim()}&rdquo; as new supplier
                          </CommandItem>
                        )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label>Operation Date</Label>
            <Input type="date" value={obTxDate} onChange={(e) => setObTxDate(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Weight (KG)</Label>
              <Input
                type="number"
                step="0.001"
                value={obReceivedKg}
                onChange={(e) => setObReceivedKg(e.target.value)}
                placeholder="0.000"
              />
            </div>
            <div className="space-y-2">
              <Label>Cost per KG</Label>
              <Input
                type="number"
                step="0.0001"
                value={obCostPerKg}
                onChange={(e) => setObCostPerKg(e.target.value)}
                placeholder="0.0000"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={obCurrency}
                onValueChange={(v) => {
                  setObCurrency(v);
                  if (v === "USD") setObFxRate("1");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["USD", "EUR", "AUD", "LBP", "GBP"].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>FX Rate to USD</Label>
              <Input
                type="number"
                step="0.0001"
                value={obFxRate}
                onChange={(e) => setObFxRate(e.target.value)}
                disabled={obCurrency === "USD"}
              />
            </div>
          </div>

          <Separator />
          <div>
            <Label className="text-sm font-semibold">Commission (optional)</Label>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div className="space-y-1">
                <Label className="text-xs">Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={obCommissionAmount}
                  onChange={(e) => setObCommissionAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Currency</Label>
                <Select
                  value={obCommissionCurrency}
                  onValueChange={(v) => {
                    setObCommissionCurrency(v);
                    if (v === "USD") setObCommissionFxRate("1");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["USD", "EUR", "AUD", "LBP", "GBP"].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Input value={obNotes} onChange={(e) => setObNotes(e.target.value)} placeholder="e.g. Opening stock..." />
          </div>

          {obKg > 0 && obRate >= 0 && (
            <div className="rounded-md border p-3 space-y-1.5 text-sm bg-muted/30">
              <p className="font-semibold">Summary</p>
              <div className="flex justify-between">
                <span>Total Value</span>
                <span className="font-mono">
                  {obCurrency !== "USD" ? `${obCurrency} ${formatNumber(obTotal)}` : `$${formatNumber(obTotal)}`}
                </span>
              </div>
              {obCurrency !== "USD" && (
                <div className="flex justify-between text-muted-foreground">
                  <span>In USD</span>
                  <span className="font-mono">${formatNumber(obTotalUsd)}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(handleSubmit, "Add Opening Balance")}
              disabled={openingBalanceMutation.isPending || !obSupplierName.trim()}
            >
              {openingBalanceMutation.isPending ? "Adding..." : "Add Opening Balance"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
