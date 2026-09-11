import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FileSpreadsheet, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useAdminOverride } from "@/hooks/use-admin-override";
import type { ContainerWithSupplier } from "./otwHelpers";

// ── Import Dialog ─────────────────────────────────────────────────────────────

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const { toast: _toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [_importPreview, setImportPreview] = [([]), (_v: unknown[]) => {}];

  const handleClose = () => {
    setImportPreview([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import Containers from Excel
          </DialogTitle>
          <DialogDescription>
            Upload an Excel file (.xlsx) to bulk-import containers. New suppliers will be created automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 text-muted-foreground text-sm">
          Use the Import Excel button in the toolbar to upload containers.
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Bulk Delete Dialog ────────────────────────────────────────────────────────

interface BulkDeleteDialogProps {
  open: boolean;
  selectedIds: Set<number>;
  onClose: () => void;
  onDeleted: () => void;
}

export function BulkDeleteDialog({ open, selectedIds, onClose, onDeleted }: BulkDeleteDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/containers/bulk-delete", { ids });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Bulk delete failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      onDeleted();
      onClose();
      toast({
        title: "Deleted",
        description: `${data.deleted} container${data.deleted !== 1 ? "s" : ""} and all linked data removed successfully.`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete {selectedIds.size} Container{selectedIds.size !== 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription>
              This action is <strong>permanent and cannot be undone</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-2 text-sm text-muted-foreground">
            <p>For each selected container, all of the following will be permanently removed:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Daybook / journal entries</li>
              <li>Vouchers and accounting entries</li>
              <li>FX allocation records</li>
              <li>Mix batch source links</li>
              <li>Offload charges (additional and pre-registered)</li>
              <li>Commission records</li>
              <li>Raw stock entries</li>
            </ul>
            <p className="text-destructive font-medium pt-1">Tip: Export All first if you need a backup.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={bulkDeleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={bulkDeleteMutation.isPending}
              onClick={() =>
                wrapAdminAction(() => bulkDeleteMutation.mutate(Array.from(selectedIds)), "Bulk Delete Containers")
              }
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleteMutation.isPending
                ? "Deleting..."
                : `Delete ${selectedIds.size} Container${selectedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

// ── Single Delete Dialog ──────────────────────────────────────────────────────

interface SingleDeleteDialogProps {
  containerId: number | null;
  onClose: () => void;
}

export function SingleDeleteDialog({ containerId, onClose }: SingleDeleteDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/containers/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete container");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      toast({ title: "Deleted", description: "Container removed" });
      onClose();
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      <Dialog
        open={containerId !== null}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Container?
            </DialogTitle>
            <DialogDescription>
              This will permanently delete the container and all its linked records — accounting entries, vouchers, FX
              allocations, mix batch links, offload charges, and raw stock. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                wrapAdminAction(() => {
                  if (containerId !== null) deleteMutation.mutate(containerId);
                }, "Delete Container")
              }
              data-testid="button-confirm-delete-container"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Container"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

// ── Reverse Offload Dialog ────────────────────────────────────────────────────

interface ReverseOffloadDialogProps {
  container: ContainerWithSupplier | null;
  onClose: () => void;
}

export function ReverseOffloadDialog({ container, onClose }: ReverseOffloadDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  const reverseOffloadMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await factoryApiRequest("POST", `/api/factory/containers/${id}/reverse-offload`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to reverse offload");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      onClose();
      toast({
        title: "Offload Reversed",
        description:
          "Container is back to its previous status. Raw stock, accounting vouchers, and daybook entries have all been removed.",
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      <Dialog
        open={!!container}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse Offload</DialogTitle>
            <DialogDescription>
              This will permanently undo the offload for container <strong>{container?.containerNumber}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-2 text-sm text-muted-foreground">
            <p>The following offload data will be permanently removed:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Raw stock entry from Raw Production</li>
              <li>Commission record and daybook entry</li>
              <li>Freight, other charges, and additional charge entries (fields cleared to zero)</li>
              <li>Duty amount and status (reset to NONE)</li>
              <li>Mix-batch source allocations linked to this container</li>
              <li>All accounting journal vouchers (freight, other charges, commission)</li>
              <li>All related daybook entries (OFFLOAD_RAW_STOCK, FREIGHT, OTHER_CHARGE, DUTY, COMMISSION)</li>
            </ul>
            <p className="text-foreground font-medium pt-1">
              The container returns to its previous status. Commission, supplier import voucher, and any payments made
              are <em>not</em> removed.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose} data-testid="button-cancel-reverse-offload">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                wrapAdminAction(() => container && reverseOffloadMutation.mutate(container.id), "Reverse Offload")
              }
              disabled={reverseOffloadMutation.isPending}
              data-testid="button-confirm-reverse-offload"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {reverseOffloadMutation.isPending ? "Reversing..." : "Reverse Offload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

// ── Excel Import/Export Utilities ─────────────────────────────────────────────

export async function exportContainers(rows: ContainerWithSupplier[], suppliersData?: Array<{ id: number; name: string }>) {
  const XLSX = await import("@/lib/excelHelper");
  const headers = [
    "Container Number",
    "Supplier",
    "Broker / Commission To",
    "Origin",
    "Total Kg",
    "Rate/Kg",
    "Currency",
    "FX Rate",
    "FX Source",
    "Arrival Date",
    "Status",
    "Notes",
    "Commission Amount",
    "Commission Currency",
    "Commission Notes",
    "Freight Amount",
    "Freight Currency",
    "Other Charges (legacy)",
  ];
  const dataRows = rows.map((c) => {
    const brokerSupId = c.commissionSupplierId;
    const brokerName = brokerSupId ? (suppliersData?.find((s) => s.id === brokerSupId)?.name ?? "") : "";
    return [
      c.containerNumber,
      c.supplierName || "",
      brokerName,
      c.origin || "",
      c.totalKg || "",
      c.ratePerKg || "",
      c.currencyCode || "USD",
      c.fxRateToUsd || "1",
      c.fxRateSource || "auto",
      c.arrivalDate || "",
      c.status,
      c.notes || "",
      c.commissionAmount || "",
      c.commissionCurrencyCode || "USD",
      c.commissionNotes || "",
      c.freight || "",
      c.freightCurrencyCode || "USD",
      c.otherCharges || "",
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  ws["!cols"] = [20, 20, 20, 12, 10, 10, 8, 8, 8, 12, 12, 30, 12, 10, 30, 12, 10, 12].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Containers");
  await XLSX.writeFile(wb, `factory_containers_export_${new Date().toLocaleDateString("en-CA")}.xlsx`);
}

export async function downloadContainerTemplate() {
  const XLSX = await import("@/lib/excelHelper");
  const headers = [
    "Container Number",
    "Supplier",
    "Origin",
    "Total Kg",
    "Rate/Kg",
    "Currency",
    "FX Rate",
    "FX Source",
    "Arrival Date",
    "Status",
    "Notes",
    "Commission Amount",
    "Commission Currency",
  ];
  const sample1 = [
    "CNTR-2024-001",
    "ABC Trading Co",
    "Australia",
    20000,
    0.5,
    "AUD",
    "",
    "AUTO",
    "2024-06-01",
    "PENDING",
    "First container",
    1000,
    "USD",
  ];
  const sample2 = [
    "CNTR-2024-002",
    "XYZ Suppliers",
    "China",
    15000,
    1.2,
    "USD",
    "1",
    "MANUAL",
    "2024-06-15",
    "IN_TRANSIT",
    "Second container - manual FX",
    "",
    "USD",
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, sample1, sample2]);
  ws["!cols"] = [18, 18, 12, 10, 10, 8, 8, 8, 12, 12, 25, 14, 14].map((w) => ({ wch: w }));
  const instructions = [
    ["FACTORY CONTAINERS IMPORT — INSTRUCTIONS"],
    [""],
    ["HOW TO USE THIS TEMPLATE"],
    ["1. Fill in the 'Containers' sheet with your data. Do NOT change column headers."],
    ["2. Supplier names are matched by exact name. New suppliers are created automatically."],
    ["3. Save as .xlsx and upload via the Import Excel button in Factory Containers."],
    ["4. When re-importing, status is forced to PENDING regardless of what you enter."],
    [""],
    ["COLUMN GUIDE"],
    ["Column", "Required", "Example", "Notes"],
    ["Container Number", "YES", "CNTR-2024-001", "Must be unique"],
    ["Supplier", "No", "ABC Trading Co", "Exact name match or new supplier created automatically"],
    ["Origin", "No", "Australia", "Country or city of origin"],
    ["Total Kg", "No", "20000", "Total weight in kg"],
    ["Rate/Kg", "No", "0.50", "Price per kg in the chosen currency"],
    ["Currency", "No", "AUD", "USD / EUR / AUD / LBP / GBP (default: USD)"],
    ["Arrival Date", "No", "2024-06-01", "YYYY-MM-DD format"],
    ["Status", "No", "PENDING", "PENDING / IN_TRANSIT / AVAILABLE / OFFLOADED"],
    ["VALID CURRENCIES: USD, EUR, AUD, LBP, GBP, XOF, XAF, CFA"],
  ];
  const wsInstr = XLSX.utils.aoa_to_sheet(instructions);
  wsInstr["!cols"] = [40, 12, 20, 50].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Containers");
  XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions");
  await XLSX.writeFile(wb, "factory_containers_template.xlsx");
}

export async function parseContainerImportFile(file: File): Promise<Record<string, string>[]> {
  const XLSX = await import("@/lib/excelHelper");
  const data = await file.arrayBuffer();
  const wb = await XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return jsonRows
    .map((row) => {
      const get = (keys: string[]) => {
        for (const k of keys) {
          const val = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
          if (val !== undefined && val !== "") return String(val).trim();
        }
        return "";
      };
      return {
        containerNumber: get(["Container Number", "Container #", "ContainerNumber", "container_number", "Container"]),
        supplierName: get(["Supplier", "Supplier Name", "SupplierName", "supplier_name"]),
        origin: get(["Origin", "Country", "origin"]),
        totalKg: get(["Total Kg", "TotalKg", "Weight", "total_kg", "KG", "Kg"]),
        ratePerKg: get(["Rate/Kg", "Rate Per Kg", "RatePerKg", "rate_per_kg", "Rate", "Price"]),
        currencyCode: get(["Currency", "CurrencyCode", "currency_code"]) || "USD",
        fxRateToUsd: get(["FX Rate", "FxRate", "fx_rate_to_usd", "Exchange Rate"]) || "",
        fxSource: get(["FX Source", "FxSource", "fx_source"]) || "",
        arrivalDate: get(["Arrival Date", "ArrivalDate", "arrival_date", "Date"]),
        notes: get(["Notes", "notes", "Remarks"]),
        status: get(["Status", "status"]) || "PENDING",
        commissionAmount: get(["Commission Amount", "CommissionAmount", "commission_amount", "Commission"]) || "",
        commissionCurrencyCode:
          get(["Commission Currency", "CommissionCurrency", "commission_currency_code", "Comm Currency"]) || "USD",
      };
    })
    .filter((r) => r.containerNumber);
}

// ── Full Import Dialog (stateful) ─────────────────────────────────────────────

interface FullImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FullImportDialog({ open: _open, onClose: _onClose }: FullImportDialogProps) {
  const { toast: _toast } = useToast();
  const _fileInputRef = useRef<HTMLInputElement>(null);
  const [_importPreview, _setImportPreview] = [([]), (_v: unknown[]) => {}];
  const [_importResult, _setImportResult] = [null, (_v: unknown) => {}];

  // This component is intentionally kept simple since the import state
  // lives in the parent (FactoryContainers) for now.
  return null;
}
