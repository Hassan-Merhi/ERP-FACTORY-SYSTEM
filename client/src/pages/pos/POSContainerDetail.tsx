import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft,
  Boxes,
  CalendarClock,
  CheckCircle2,
  Download,
  FileClock,
  MapPin,
  Package,
  Search,
  Truck,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";

interface PosContainerItem {
  itemName: string;
  itemCode: string;
  quantity: string;
}

interface PosContainerDetailResponse {
  container: {
    id: number;
    containerNumber: string;
    supplierName: string | null;
    supplierCode: string | null;
    status: string;
    eta: string | null;
    numberPlate: string | null;
    trackingLocation: string | null;
    agent: string | null;
    transporter: string | null;
    docReceived: boolean | null;
    docsSentDate: string | null;
  };
  items: PosContainerItem[];
  totalQty: number;
}

async function loadContainerDetail(id: string): Promise<PosContainerDetailResponse> {
  const response = await fetch(`/api/pos/containers-otw/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Failed to load container");
  return body;
}

function formatQty(value: string | number): string {
  const quantity = Number.parseFloat(String(value));
  if (!Number.isFinite(quantity)) return "0";
  return quantity.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export default function POSContainerDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const containerId = params.id;

  const { data, isLoading, isError, error } = useQuery<PosContainerDetailResponse>({
    queryKey: ["/api/pos/containers-otw/detail", containerId],
    queryFn: () => loadContainerDetail(containerId),
    enabled: Boolean(containerId),
    staleTime: 30_000,
  });

  const filteredItems = useMemo(() => {
    if (!data) return [];
    const normalized = search.trim().toLowerCase();
    if (!normalized) return data.items;
    return data.items.filter((item) => `${item.itemCode} ${item.itemName}`.toLowerCase().includes(normalized));
  }, [data, search]);

  async function exportNoCostNoFreight() {
    if (!data) return;
    try {
      const { ExcelJS } = await import("@/lib/excelHelper");
      const supplierLabel = data.container.supplierCode || data.container.supplierName || "";
      const containerNumber = data.container.containerNumber || "";
      const truckNumber = data.container.numberPlate || "";

      // Match the ERP container No Cost / Freight export format exactly.
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Container Items");

      // Column definitions: NO | BARCODE (hidden) | DESCRIPTION | Q'TY
      ws.columns = [
        { key: "no", width: 6 },
        { key: "bc", width: 20, hidden: true },
        { key: "desc", width: 70 },
        { key: "qty", width: 18 },
      ];

      // Row 1: supplier label (merged A1:D1)
      ws.addRow([supplierLabel, "", "", ""]);
      ws.mergeCells("A1:D1");
      const r1 = ws.getRow(1);
      r1.height = 28;
      r1.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B2A4A" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // Row 2: container (A2:C2) + truck (D2)
      ws.addRow([`CONTAINER: ${containerNumber}`, "", "", `TRUCK: ${truckNumber}`]);
      ws.mergeCells("A2:C2");
      const r2 = ws.getRow(2);
      r2.height = 22;
      r2.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };
        cell.font = { bold: true, size: 11 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // Row 3: column headers
      ws.addRow(["NO", "BARCODE", "DESCRIPTION", "Q'TY"]);
      const r3 = ws.getRow(3);
      r3.eachCell((cell, colNum) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2E3B4E" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = {
          horizontal: colNum === 3 ? "left" : "center",
          vertical: "middle",
        };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // Rows 4+: line items
      data.items.forEach((item, index) => {
        const rowNumber = index + 1;
        const isEven = rowNumber % 2 === 0;
        const row = ws.addRow([
          rowNumber,
          item.itemCode || "",
          item.itemName || "",
          Number.parseFloat(item.quantity) || 0,
        ]);
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          if (isEven) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FC" } };
          }
          cell.alignment = {
            horizontal: colNum === 3 ? "left" : "center",
            vertical: "middle",
            wrapText: colNum === 3,
          };
          cell.border = {
            top: { style: "thin" },
            bottom: { style: "thin" },
            left: { style: "thin" },
            right: { style: "thin" },
          };
          cell.font = { size: 10 };
        });
      });

      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 3 }];

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `container_${containerNumber}_no_cost.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      toast({
        title: "No-cost export downloaded",
        description: "The file uses the same layout as the ERP No Cost / Freight export.",
      });
    } catch (exportError) {
      toast({
        title: "Export failed",
        description: exportError instanceof Error ? exportError.message : "Unable to create Excel export",
        variant: "destructive",
      });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-3 sm:p-4" data-testid="pos-container-detail-loading">
        <Skeleton className="h-12 w-80 max-w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-72 items-center justify-center p-4 text-center">
        <div>
          <Package className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 font-medium">Container unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Container not found"}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => setLocation("/pos-containers")}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to containers
          </Button>
        </div>
      </div>
    );
  }

  const supplier = data.container.supplierCode || data.container.supplierName || "—";

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-3 sm:p-4 lg:p-5"
      data-testid="pos-container-detail-page"
    >
      <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/pos-containers")}
            aria-label="Back to containers"
            data-testid="button-pos-container-back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                Container {data.container.containerNumber}
              </h1>
              <Badge variant="outline">{data.container.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Item quantities only — cost and freight stay hidden for POS users.
            </p>
          </div>
        </div>
        <Button onClick={exportNoCostNoFreight} className="gap-2" data-testid="button-pos-container-no-cost-export">
          <Download className="h-4 w-4" aria-hidden="true" />
          No Cost / No Freight Export
        </Button>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-card/60 p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total Qty</p>
            <Boxes className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="text-pos-container-total-qty">
            {formatQty(data.totalQty)}
          </p>
        </div>
        <div className="rounded-xl border bg-card/60 p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Item Lines</p>
            <Package className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{data.items.length}</p>
        </div>
        <div className="rounded-xl border bg-card/60 p-3 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Supplier</p>
          <p className="mt-2 truncate text-base font-semibold" title={supplier}>
            {supplier}
          </p>
        </div>
        <div className="rounded-xl border bg-card/60 p-3 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Truck</p>
            <Truck className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-2 truncate font-mono text-base font-semibold">
            {data.container.numberPlate || "Not assigned"}
          </p>
        </div>
      </div>

      <div className="shrink-0 rounded-xl border bg-card/40 p-3 shadow-sm">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div>
            <p className="text-xs text-muted-foreground">ETA</p>
            <p className="mt-1 flex items-center gap-1.5 font-medium">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {data.container.eta ? formatDisplayDate(data.container.eta) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Location</p>
            <p className="mt-1 flex items-center gap-1.5 font-medium">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {data.container.trackingLocation || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Agent</p>
            <p className="mt-1 flex items-center gap-1.5 font-medium">
              <UserRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {data.container.agent || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Transporter</p>
            <p className="mt-1 flex items-center gap-1.5 font-medium">
              <Truck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {data.container.transporter || "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Docs</p>
            <div className="mt-1">
              {data.container.docReceived ? (
                <Badge className="gap-1 border-emerald-500/20 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Received
                </Badge>
              ) : (
                <Badge variant="secondary">Pending</Badge>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Docs Sent</p>
            <p className="mt-1 flex items-center gap-1.5 font-medium">
              <FileClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {data.container.docsSentDate ? formatDisplayDate(data.container.docsSentDate) : "Not sent"}
            </p>
          </div>
        </div>
      </div>

      <div className="shrink-0 rounded-xl border bg-card/40 p-3 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search item name or code..."
              className="pl-9"
              data-testid="input-pos-container-item-search"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {filteredItems.length} of {data.items.length} item lines
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card/30 shadow-sm" data-table-scroll-region>
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
            <TableRow>
              <TableHead className="w-16 text-center">No.</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead className="w-32 text-right">Qty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                  {search ? "No items match your search" : "No items found in this container"}
                </TableCell>
              </TableRow>
            ) : (
              filteredItems.map((item, index) => (
                <TableRow
                  key={`${item.itemCode}-${item.itemName}-${index}`}
                  className="transition-colors hover:bg-muted/40"
                  data-testid={`row-pos-container-item-${index}`}
                >
                  <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableCell className="font-medium">{item.itemName}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatQty(item.quantity)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell />
              <TableCell className="font-semibold">Total Qty</TableCell>
              <TableCell className="text-right text-base font-bold tabular-nums">{formatQty(data.totalQty)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
