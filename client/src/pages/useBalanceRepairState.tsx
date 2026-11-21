// Extracted from ./BalanceRepair.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Types ──────────────────────────────────────────────────────────────────
interface LedgerDrift {
  id: number;
  contractId: number;
  year: number;
  month: number;
  module: string;
  tenantName: string;
  unitLabel: string;
  storedPaid: number;
  computedPaid: number;
  diff: number;
}

interface VoucherEntryMissing {
  paymentId: number;
  voucherId: number;
  contractId: number;
  module: string;
  tenantName: string;
  unitLabel: string;
  amount: number;
  paymentDate: string;
  cashAccountName: string;
  unitType: string;
  issue: "EMPTY_VOUCHER" | "SOFT_DELETED_VOUCHER";
}

interface OrphanedTransfer {
  transferId: number;
  description: string;
  amount: number;
  transferDate: string;
  fromCompanyName: string;
  toCompanyName: string;
  orphanedSide: "FROM" | "TO";
  orphanedVoucherId: number;
  issue: "SOFT_DELETED" | "EMPTY_ENTRIES";
}

interface DepositFlagMismatch {
  contractId: number;
  tenantName: string;
  unitLabel: string;
  module: string;
  guaranteeAmount: number;
  voucherAmount?: number;
  flagValue: boolean;
  voucherExists: boolean;
  issue: "STALE_FLAG" | "MISSING_FLAG" | "AMOUNT_MISMATCH";
}

interface ScanResult {
  ledgerDrifts: LedgerDrift[];
  voucherEntryMissing: VoucherEntryMissing[];
  orphanedTransfers: OrphanedTransfer[];
  depositFlagMismatches: DepositFlagMismatch[];
  totalDiscrepancies: number;
}

type Phase = "idle" | "scanning" | "scanned" | "applying" | "applied" | "undoing";

export function ModuleBadge({ module }: { module: string }) {
  const label = module === "ERP" ? "ERP Shops" : module === "FACTORY" ? "Factory" : "Properties";
  return <Badge variant="secondary">{label}</Badge>;
}

export function IssueBadge({ issue }: { issue: string }) {
  const labels: Record<string, string> = {
    STALE_FLAG: "No ledger entry",
    MISSING_FLAG: "Flag not set",
    AMOUNT_MISMATCH: "Amount mismatch",
    EMPTY_VOUCHER: "Voucher has no entries",
    SOFT_DELETED_VOUCHER: "Voucher was deleted",
    SOFT_DELETED: "Voucher soft-deleted",
    EMPTY_ENTRIES: "Voucher has no entries",
  };
  return <Badge variant="destructive">{labels[issue] ?? issue}</Badge>;
}

export function useBalanceRepairState() {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<ScanResult | null>(null);
  // The run apply recorded (its id identifies it to undo) and the snapshot it returned.
  const [undoRun, setUndoRun] = useState<{ repairRunId: number; snapshot: unknown } | null>(null);
  const [applied, setApplied] = useState<{
    ledger: number;
    vouchers: number;
    orphans: number;
    deposits: number;
  } | null>(null);

  async function runScan() {
    setPhase("scanning");
    setScan(null);
    setUndoRun(null);
    setApplied(null);
    try {
      const res = await apiRequest("GET", "/api/admin/repair-balances/scan");
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      const data: ScanResult = await res.json();
      setScan(data);
      setPhase("scanned");
      toast({
        title: "Scan complete",
        description:
          data.totalDiscrepancies === 0
            ? "No discrepancies found — everything looks good."
            : `Found ${data.totalDiscrepancies} issue${data.totalDiscrepancies !== 1 ? "s" : ""}.`,
      });
    } catch (e) {
      toast({ title: "Scan failed", description: getErrorDetails(e).message, variant: "destructive" });
      setPhase("idle");
    }
  }

  async function applyFixes() {
    setPhase("applying");
    try {
      const res = await apiRequest("POST", "/api/admin/repair-balances/apply", {});
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      const data = await res.json();
      setUndoRun({ repairRunId: data.repairRunId, snapshot: data.snapshot });
      setApplied({
        ledger: data.ledgerFixed,
        vouchers: data.voucherEntriesFixed,
        orphans: data.orphansFixed,
        deposits: data.depositsFixed,
      });
      setScan(null);
      setPhase("applied");
      toast({
        title: "Fixes applied",
        description: `${data.ledgerFixed} ledger row(s), ${data.voucherEntriesFixed} voucher(s), ${data.orphansFixed} orphaned transfer(s), ${data.depositsFixed} deposit flag(s).`,
      });
    } catch (e) {
      toast({ title: "Repair failed", description: getErrorDetails(e).message, variant: "destructive" });
      setPhase("scanned");
    }
  }
  return { applied, applyFixes, phase, runScan, scan, setApplied, setPhase, setScan, setUndoRun, undoRun, toast };
}
