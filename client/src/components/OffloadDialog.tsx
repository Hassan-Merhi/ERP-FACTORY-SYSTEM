import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Plus, X, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";
import type { Location } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";

interface OffloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerId: number;
  containerNumber: string;
  totalBales: number;
}

interface AdditionalCharge {
  id: string;
  description: string;
  amount: string;
  ledgerAccountId: string;
}

interface LedgerAccountOption {
  id: string | number;
  name: string;
}

interface SpSetupAccountOption {
  id: string | number;
  subType: string;
  name?: string | null;
}

interface SpSetupStatusData {
  spAccounts?: SpSetupAccountOption[];
}

interface ParentAgentOption {
  ledger_account_id: string | number;
  account_name: string;
}

interface ContainerCharge {
  amount?: string | number | null;
}

interface ContainerOffloadData {
  charges?: ContainerCharge[];
}

interface AccountComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts: LedgerAccountOption[];
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

function AccountCombobox({
  value,
  onValueChange,
  accounts,
  placeholder = "Select account",
  disabled = false,
  testId,
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedAccount = accounts.find((account) => account.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={disabled}
          data-testid={testId}
        >
          {selectedAccount ? selectedAccount.name : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search accounts..." />
          <CommandList>
            <CommandEmpty>No account found.</CommandEmpty>
            <CommandGroup>
              {accounts.map((account) => (
                <CommandItem
                  key={account.id}
                  value={account.name}
                  onSelect={() => {
                    onValueChange(account.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === account.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {account.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface LocationComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  locations: Location[];
  placeholder?: string;
  testId?: string;
}

function LocationCombobox({
  value,
  onValueChange,
  locations,
  placeholder = "Select location",
  testId,
}: LocationComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedLocation = locations.find((location) => location.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid={testId}
        >
          {selectedLocation ? selectedLocation.name : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search locations..." />
          <CommandList>
            <CommandEmpty>No location found.</CommandEmpty>
            <CommandGroup>
              {locations.map((location) => (
                <CommandItem
                  key={location.id}
                  value={location.name}
                  onSelect={() => {
                    onValueChange(location.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === location.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {location.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function OffloadDialog({ open, onOpenChange, containerId, containerNumber, totalBales }: OffloadDialogProps) {
  const [_location, setLocation] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const isSpCompany = selectedCompany?.companyType === "supplier_partner";

  // ── Shared state ──────────────────────────────────────────────────────────
  const [locationId, setLocationId] = useState<number | null>(null);
  const [offloadDate, setOffloadDate] = useState(new Date().toLocaleDateString("en-CA"));

  // ── ERP-only state ────────────────────────────────────────────────────────
  const [duties, setDuties] = useState("0");
  const [dutiesAccountId, setDutiesAccountId] = useState("");
  const [transportFees, setTransportFees] = useState("0");
  const [transportAccountId, setTransportAccountId] = useState("");
  const [additionalCharges, setAdditionalCharges] = useState<AdditionalCharge[]>([]);

  // ── SP-mode state ─────────────────────────────────────────────────────────
  const [spDutiesAmount, setSpDutiesAmount] = useState("");
  const [spDutiesMethod, setSpDutiesMethod] = useState<"prepaid_expenses" | "parent_agent">("prepaid_expenses");
  const [spDutiesAgentId, setSpDutiesAgentId] = useState("");
  const [spTransportAmount, setSpTransportAmount] = useState("");
  const [spTransportMethod, setSpTransportMethod] = useState<"prepaid_expenses" | "parent_agent">("prepaid_expenses");
  const [spTransportAgentId, setSpTransportAgentId] = useState("");

  // Reset all form state whenever the dialog opens or targets a new container
  useEffect(() => {
    if (!open) return;
    setLocationId(null);
    setOffloadDate(new Date().toLocaleDateString("en-CA"));
    // ERP fields
    setDuties("0");
    setDutiesAccountId("");
    setTransportFees("0");
    setTransportAccountId("");
    setAdditionalCharges([]);
    // SP fields
    setSpDutiesAmount("");
    setSpDutiesMethod("prepaid_expenses");
    setSpDutiesAgentId("");
    setSpTransportAmount("");
    setSpTransportMethod("prepaid_expenses");
    setSpTransportAgentId("");
  }, [open, containerId]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccountOption[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: open && !isSpCompany,
  });

  const { data: spStatusData } = useQuery<SpSetupStatusData>({
    queryKey: ["/api/sp/setup/status"],
    enabled: open && isSpCompany,
  });

  const { data: parentAgents = [] } = useQuery<ParentAgentOption[]>({
    queryKey: ["/api/sp/parent-agents"],
    enabled: open && isSpCompany,
  });

  const { data: containerData } = useQuery<ContainerOffloadData>({
    queryKey: [`/api/containers/${containerId}`],
    enabled: open && !!containerId,
  });

  // ── Derived SP accounts ───────────────────────────────────────────────────
  const spPrepaidExpAcct = (spStatusData?.spAccounts || []).find(
    (a: { subType: string }) => a.subType === "sp_prepaid_expenses"
  );
  const spHadiIcAcct = (spStatusData?.spAccounts || []).find(
    (a: { subType: string }) => a.subType === "sp_hadi_intercompany"
  );

  // ── Charge calculations ───────────────────────────────────────────────────
  let poChargesTotal = 0;
  if (containerData?.charges && Array.isArray(containerData.charges)) {
    containerData.charges.forEach((charge) => {
      const amount = parseFloat(String(charge.amount ?? "0"));
      if (amount > 0) poChargesTotal += amount;
    });
  }

  const erpManualCharges =
    parseFloat(duties || "0") +
    parseFloat(transportFees || "0") +
    additionalCharges.reduce((sum, charge) => sum + parseFloat(String(charge.amount ?? "0")), 0);

  const spManualCharges = parseFloat(spDutiesAmount || "0") + parseFloat(spTransportAmount || "0");

  const manualCharges = isSpCompany ? spManualCharges : erpManualCharges;
  const totalCharges = manualCharges + poChargesTotal;
  const additionalCostPerBale = totalBales > 0 ? totalCharges / totalBales : 0;

  // ── ERP handlers ──────────────────────────────────────────────────────────
  const handleAddCharge = () => {
    setAdditionalCharges([
      ...additionalCharges,
      { id: Date.now().toString(), description: "", amount: "0", ledgerAccountId: "" },
    ]);
  };

  const handleRemoveCharge = (id: string) => {
    setAdditionalCharges(additionalCharges.filter((c) => c.id !== id));
  };

  const handleUpdateCharge = (id: string, field: keyof AdditionalCharge, value: string) => {
    setAdditionalCharges(additionalCharges.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  // ── Mutation ──────────────────────────────────────────────────────────────
  const offloadMutation = useMutation({
    mutationFn: async () => {
      if (!locationId) throw new Error("Please select a location");

      if (isSpCompany) {
        const dutiesAmt = parseFloat(spDutiesAmount || "0");
        const transportAmt = parseFloat(spTransportAmount || "0");

        if (dutiesAmt > 0 && spDutiesMethod === "parent_agent" && !spDutiesAgentId) {
          throw new Error("Please select an agent for duties");
        }
        if (transportAmt > 0 && spTransportMethod === "parent_agent" && !spTransportAgentId) {
          throw new Error("Please select an agent for transport");
        }
        if (!spPrepaidExpAcct) throw new Error("SP Prepaid Expenses account not found. Run SP Setup first.");
        if (!spHadiIcAcct) throw new Error("SP Intercompany account not found. Run SP Setup first.");

        const resolvedDutiesAccountId =
          dutiesAmt > 0 ? (spDutiesMethod === "prepaid_expenses" ? spPrepaidExpAcct.id : spHadiIcAcct.id) : null;
        const resolvedTransportAccountId =
          transportAmt > 0 ? (spTransportMethod === "prepaid_expenses" ? spPrepaidExpAcct.id : spHadiIcAcct.id) : null;

        const agentChargeLines = [];
        if (dutiesAmt > 0 && spDutiesMethod === "parent_agent") {
          agentChargeLines.push({
            description: "Duties",
            amountUsd: dutiesAmt,
            parentAgentAccountId: parseInt(spDutiesAgentId),
          });
        }
        if (transportAmt > 0 && spTransportMethod === "parent_agent") {
          agentChargeLines.push({
            description: "Transport",
            amountUsd: transportAmt,
            parentAgentAccountId: parseInt(spTransportAgentId),
          });
        }

        const response = await factoryApiRequest("POST", `/api/containers/${containerId}/offload`, {
          locationId,
          offloadDate,
          duties: String(dutiesAmt),
          dutiesAccountId: resolvedDutiesAccountId,
          officeCharges: "0",
          officeChargesAccountId: null,
          officeChargesCashAccountId: null,
          transferCharges: "0",
          transportFees: String(transportAmt),
          transportAccountId: resolvedTransportAccountId,
          additionalCharges: [],
          inventoryCostCorrections: [],
          agentChargeLines,
        });
        return await response.json();
      } else {
        if (parseFloat(duties) > 0 && !dutiesAccountId) {
          throw new Error("Please select an account for duties");
        }
        if (parseFloat(transportFees) > 0 && !transportAccountId) {
          throw new Error("Please select an account for transport fees");
        }
        for (const charge of additionalCharges) {
          if (parseFloat(charge.amount) > 0) {
            if (!charge.description) throw new Error("Please provide a description for all additional charges");
            if (!charge.ledgerAccountId) throw new Error("Please select an account for all additional charges");
          }
        }

        const response = await factoryApiRequest("POST", `/api/containers/${containerId}/offload`, {
          locationId,
          offloadDate,
          duties,
          dutiesAccountId: dutiesAccountId ? parseInt(dutiesAccountId) : null,
          officeCharges: "0",
          officeChargesAccountId: null,
          officeChargesCashAccountId: null,
          transferCharges: "0",
          transportFees,
          transportAccountId: transportAccountId ? parseInt(transportAccountId) : null,
          additionalCharges: additionalCharges
            .filter((c) => parseFloat(c.amount) > 0)
            .map((c) => ({
              description: c.description,
              amount: parseFloat(c.amount),
              ledgerAccountId: parseInt(c.ledgerAccountId),
            })),
          inventoryCostCorrections: [],
          agentChargeLines: [],
        });
        return await response.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith("/api/stock-items/");
        },
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      toast({
        title: "Container offloaded successfully",
        description: `Container ${containerNumber} has been offloaded to the selected location.`,
      });
      onOpenChange(false);
      setLocation("/containers");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Offload failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    offloadMutation.mutate();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="pb-2">
          <DialogTitle className="text-lg">Offload Container {containerNumber}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {isSpCompany
              ? "Set the offload date, enter any landed charges, and choose a destination location."
              : "Enter charges, select accounts, and choose a destination. The total cost per bale will be recalculated automatically."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Offload Date */}
          <div className="space-y-1.5">
            <Label htmlFor="offload-date" className="text-sm font-medium">
              Offload Date
            </Label>
            <Input
              id="offload-date"
              type="date"
              value={offloadDate}
              onChange={(e) => setOffloadDate(e.target.value)}
              data-testid="input-offload-date"
            />
          </div>

          {/* Charges section */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Landed Charges</p>

            {isSpCompany ? (
              <>
                {/* SP — Duties */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Duties</Label>
                  <div className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount"
                        value={spDutiesAmount}
                        onChange={(e) => setSpDutiesAmount(e.target.value)}
                        data-testid="input-sp-duties"
                      />
                    </div>
                    <div className="col-span-4">
                      <Select
                        value={spDutiesMethod}
                        onValueChange={(v) => {
                          setSpDutiesMethod(v as "prepaid_expenses" | "parent_agent");
                          setSpDutiesAgentId("");
                        }}
                      >
                        <SelectTrigger data-testid="select-sp-duties-method">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="prepaid_expenses">Prepaid Expenses</SelectItem>
                          <SelectItem value="parent_agent">Agent via HADI L&apos;SHI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {spDutiesMethod === "prepaid_expenses" ? (
                      <div className="col-span-5 flex items-center h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground">
                        {spPrepaidExpAcct?.name ?? "Prepaid Expenses"}
                      </div>
                    ) : (
                      <div className="col-span-5">
                        <Select value={spDutiesAgentId} onValueChange={setSpDutiesAgentId}>
                          <SelectTrigger data-testid="select-sp-duties-agent">
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {parentAgents.map((a) => (
                              <SelectItem key={a.ledger_account_id} value={String(a.ledger_account_id)}>
                                {a.account_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>

                {/* SP — Transport */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Transport</Label>
                  <div className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount"
                        value={spTransportAmount}
                        onChange={(e) => setSpTransportAmount(e.target.value)}
                        data-testid="input-sp-transport"
                      />
                    </div>
                    <div className="col-span-4">
                      <Select
                        value={spTransportMethod}
                        onValueChange={(v) => {
                          setSpTransportMethod(v as "prepaid_expenses" | "parent_agent");
                          setSpTransportAgentId("");
                        }}
                      >
                        <SelectTrigger data-testid="select-sp-transport-method">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="prepaid_expenses">Prepaid Expenses</SelectItem>
                          <SelectItem value="parent_agent">Agent via HADI L&apos;SHI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {spTransportMethod === "prepaid_expenses" ? (
                      <div className="col-span-5 flex items-center h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground">
                        {spPrepaidExpAcct?.name ?? "Prepaid Expenses"}
                      </div>
                    ) : (
                      <div className="col-span-5">
                        <Select value={spTransportAgentId} onValueChange={setSpTransportAgentId}>
                          <SelectTrigger data-testid="select-sp-transport-agent">
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {parentAgents.map((a) => (
                              <SelectItem key={a.ledger_account_id} value={String(a.ledger_account_id)}>
                                {a.account_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* ERP — Duties */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Duties</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={duties}
                      onChange={(e) => setDuties(e.target.value)}
                      data-testid="input-duties"
                    />
                    <AccountCombobox
                      value={dutiesAccountId}
                      onValueChange={setDutiesAccountId}
                      accounts={ledgerAccounts}
                      placeholder="Select account"
                      disabled={parseFloat(duties) === 0}
                      testId="select-duties-account"
                    />
                  </div>
                </div>

                {/* ERP — Transport Fees */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Transport Fees</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={transportFees}
                      onChange={(e) => setTransportFees(e.target.value)}
                      data-testid="input-transport-fees"
                    />
                    <AccountCombobox
                      value={transportAccountId}
                      onValueChange={setTransportAccountId}
                      accounts={ledgerAccounts}
                      placeholder="Select account"
                      disabled={parseFloat(transportFees) === 0}
                      testId="select-transport-account"
                    />
                  </div>
                </div>

                {/* ERP — Additional Charges */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium text-muted-foreground">Additional Charges</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddCharge}
                      className="gap-1.5 h-7 text-xs"
                      data-testid="button-add-charge"
                    >
                      <Plus className="h-3 w-3" />
                      Add
                    </Button>
                  </div>
                  {additionalCharges.length > 0 && (
                    <div className="space-y-2">
                      {additionalCharges.map((charge) => (
                        <div key={charge.id} className="grid grid-cols-12 gap-2 items-start">
                          <Input
                            placeholder="Description"
                            value={charge.description}
                            onChange={(e) => handleUpdateCharge(charge.id, "description", e.target.value)}
                            className="col-span-4"
                            data-testid={`input-charge-description-${charge.id}`}
                          />
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Amount"
                            value={charge.amount}
                            onChange={(e) => handleUpdateCharge(charge.id, "amount", e.target.value)}
                            className="col-span-3"
                            data-testid={`input-charge-amount-${charge.id}`}
                          />
                          <div className="col-span-4">
                            <AccountCombobox
                              value={charge.ledgerAccountId}
                              onValueChange={(value) => handleUpdateCharge(charge.id, "ledgerAccountId", value)}
                              accounts={ledgerAccounts}
                              placeholder="Select account"
                              testId={`select-charge-account-${charge.id}`}
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveCharge(charge.id)}
                            className="col-span-1"
                            data-testid={`button-remove-charge-${charge.id}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Destination Location */}
          <div className="space-y-1.5">
            <Label htmlFor="location" className="text-sm font-medium">
              Destination Location
            </Label>
            <LocationCombobox
              value={locationId?.toString() || ""}
              onValueChange={(value) => setLocationId(parseInt(value))}
              locations={locations}
              placeholder="Select a location"
              testId="select-location"
            />
          </div>

          {/* Calculation Summary */}
          {(totalCharges > 0 || totalBales > 0) && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
              <div className="space-y-1.5 text-sm">
                {manualCharges > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Manual Charges</span>
                    <span className="font-medium tabular-nums">${formatNumber(manualCharges)}</span>
                  </div>
                )}
                {poChargesTotal > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PO Charges (Freight, Docs, etc.)</span>
                    <span className="font-medium tabular-nums">${formatNumber(poChargesTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                  <span>Total Charges</span>
                  <span className="tabular-nums" data-testid="text-total-charges">
                    ${formatNumber(totalCharges)}
                  </span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Total Bales</span>
                  <span className="tabular-nums" data-testid="text-total-bales">
                    {formatNumber(totalBales)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                  <span>Cost Added per Bale</span>
                  <span className="tabular-nums" data-testid="text-cost-per-bale">
                    ${formatNumber(additionalCostPerBale)}
                  </span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={offloadMutation.isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={offloadMutation.isPending || !locationId} data-testid="button-offload">
              {offloadMutation.isPending ? "Offloading..." : "Offload Container"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
