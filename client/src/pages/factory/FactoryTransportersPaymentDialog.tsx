// Extracted from ./FactoryTransporters.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const API = "/api/factory/transporters";

export function fmt(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type LedgerAccount = { id: number; name: string; accountType: string };

export type Transporter = {
  id: number;
  name: string;
  phone?: string;
  notes?: string;
  totalCharged: number;
  totalPaid: number;
  outstanding: number;
};

type Transaction = {
  id: number;
  txType: "charge" | "payment";
  amount: string;
  txDate: string;
  description?: string;
  runningBalance: number;
};

export type TransporterDetail = Transporter & { transactions: Transaction[] };

// ─────────────────────────────────────────────────────────────
// ACCOUNT COMBOBOX (simple select for now)
// ─────────────────────────────────────────────────────────────
function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder,
  filter,
}: {
  accounts: LedgerAccount[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  filter?: (a: LedgerAccount) => boolean;
}) {
  const list = filter ? accounts.filter(filter) : accounts;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {list.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>
            {a.name} <span className="text-muted-foreground text-xs ml-1">({a.accountType})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─────────────────────────────────────────────────────────────
// CHARGE DIALOG
// ─────────────────────────────────────────────────────────────
export function ChargeDialog({
  transporterId,
  open,
  onClose,
}: {
  transporterId: number;
  open: boolean;
  onClose: () => void;
}) {
  const { selectedCompany } = useCompany();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [txDate, setTxDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");

  const { data: accounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyQueryKey("/api/factory/transporter-accounts", selectedCompany?.id),
    enabled: open && Boolean(selectedCompany?.id),
  });

  const charge = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${API}/${transporterId}/charges`, {
        amount,
        txDate,
        description,
        expenseAccountId: parseInt(expenseAccountId),
      }),
    onSuccess: () => {
      toast({ title: "Charge recorded" });
      queryClient.invalidateQueries({ queryKey: [API] });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(API, selectedCompany?.id, transporterId) });
      setAmount("");
      setDescription("");
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Charge</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Dr Expense Account / Cr Transporter Account</p>
            <div>
              <Label>Amount ($) *</Label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-charge-amount"
              />
            </div>
            <div>
              <Label>Date *</Label>
              <Input
                type="date"
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                data-testid="input-charge-date"
              />
            </div>
            <div>
              <Label>Expense Account *</Label>
              <AccountSelect
                accounts={accounts}
                value={expenseAccountId}
                onChange={setExpenseAccountId}
                placeholder="Select expense account…"
                filter={(a) => ["Expense", "Direct Expense", "Indirect Expense"].includes(a.accountType)}
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Container offload BL#12345"
                data-testid="input-charge-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => charge.mutate(), "Record Charge")}
              disabled={!amount || !expenseAccountId || charge.isPending}
              data-testid="button-save-charge"
            >
              {charge.isPending ? "Saving…" : "Record Charge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// PAYMENT DIALOG
// ─────────────────────────────────────────────────────────────
export function PaymentDialog({
  transporterId,
  open,
  onClose,
}: {
  transporterId: number;
  open: boolean;
  onClose: () => void;
}) {
  const { selectedCompany } = useCompany();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [txDate, setTxDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");

  const { data: accounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyQueryKey("/api/factory/transporter-accounts", selectedCompany?.id),
    enabled: open && Boolean(selectedCompany?.id),
  });

  const pay = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${API}/${transporterId}/payments`, {
        amount,
        txDate,
        description,
        cashAccountId: parseInt(cashAccountId),
      }),
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      queryClient.invalidateQueries({ queryKey: [API] });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(API, selectedCompany?.id, transporterId) });
      setAmount("");
      setDescription("");
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Dr Transporter Account / Cr Cash</p>
            <div>
              <Label>Amount ($) *</Label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-payment-amount"
              />
            </div>
            <div>
              <Label>Date *</Label>
              <Input
                type="date"
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                data-testid="input-payment-date"
              />
            </div>
            <div>
              <Label>Cash / Bank Account *</Label>
              <AccountSelect
                accounts={accounts}
                value={cashAccountId}
                onChange={setCashAccountId}
                placeholder="Select cash account…"
                filter={(a) => ["Cash", "Bank"].includes(a.accountType)}
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Payment for April services"
                data-testid="input-payment-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => pay.mutate(), "Record Payment")}
              disabled={!amount || !cashAccountId || pay.isPending}
              data-testid="button-save-payment"
            >
              {pay.isPending ? "Saving…" : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}
