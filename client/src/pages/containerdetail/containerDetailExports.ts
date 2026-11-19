// Extracted from ./useContainerDetailModel.tsx: container Excel export and price-import handlers.
import { getErrorDetails } from "@shared/errorUtils";
import { ExcelJS, read as readExcel } from "@/lib/excelHelper";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import type { useToast } from "@/hooks/use-toast";
import type { ContainerPriceImportPreviewRow } from "./useContainerDetailModel";

export async function exportContainerWithoutCost({
  toast,
  containerId,
}: {
  toast: ReturnType<typeof useToast>["toast"];
  containerId: string | undefined;
}) {
  if (!navigator.onLine) {
    toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
    return;
  }
  try {
    const response = await fetch(`/api/containers/${containerId}/export`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Export failed");

    const supplierLabel =
      data.supplier?.code ||
      data.container?.supplierCode ||
      data.supplier?.legalName ||
      data.container?.supplierName ||
      "";
    const containerNumber = data.container?.containerNumber || "";
    const truckNumber = data.container?.numberPlate || data.container?.truckNumber || "";

    // ── build ExcelJS workbook directly for full styling support ──
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Container Items");

    // Column definitions: NO | BARCODE (hidden) | DESCRIPTION | Q'TY
    ws.columns = [
      { key: "no", width: 6 },
      { key: "bc", width: 20, hidden: true },
      { key: "desc", width: 70 },
      { key: "qty", width: 18 },
    ];

    // ── Row 1: supplier label (merged A1:D1) ──
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

    // ── Row 2: container (A2:C2) + truck (D2) ──
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

    // ── Row 3: column headers ──
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

    // ── Rows 4+: line items ──
    let idx = 1;
    for (const po of data.purchaseOrders || []) {
      for (const item of po.lineItems || []) {
        const isEven = idx % 2 === 0;
        const row = ws.addRow([
          idx,
          item.stockItemCode || "",
          item.stockItemName || "",
          parseFloat(item.quantity) || 0,
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
        idx++;
      }
    }

    // Freeze top 3 rows
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 3 }];

    // ── download ──
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    downloadBlob(blob, exportFileName(`container ${containerNumber} no cost`, "xlsx"));

    toast({ title: "No-cost export downloaded" });
  } catch (error) {
    toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
  }
}

export async function importContainerPriceFile({
  setPriceImportError,
  setPriceImportPreview,
  setPriceImportParsing,
  file,
  pricePreviewMutation,
}: {
  setPriceImportError: React.Dispatch<React.SetStateAction<string | null>>;
  setPriceImportPreview: React.Dispatch<React.SetStateAction<ContainerPriceImportPreviewRow[] | null>>;
  setPriceImportParsing: React.Dispatch<React.SetStateAction<boolean>>;
  file: File;
  pricePreviewMutation: { mutate: (rows: { barcode: string; price: string }[]) => void };
}) {
  setPriceImportError(null);
  setPriceImportPreview(null);
  setPriceImportParsing(true);
  try {
    const wb = await readExcel(file);
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows: { barcode: string; price: string }[] = [];
    let barcodeCol = -1;
    let priceCol = -1;
    let headerRow = -1;

    sheet.eachRow((row, rowNumber: number) => {
      const vals = row.values as unknown[];
      if (headerRow === -1) {
        vals.forEach((cell, colIdx: number) => {
          const v = String(cell || "")
            .toLowerCase()
            .trim();
          if (v === "barcode" || v === "barcodes" || v === "bar_code" || v === "code") barcodeCol = colIdx;
          if (v === "price" || v === "new_price" || v === "newprice" || v === "unit_price" || v === "unit price")
            priceCol = colIdx;
        });
        if (barcodeCol !== -1 && priceCol !== -1) {
          headerRow = rowNumber;
        }
        return;
      }
      const barcode = String(vals[barcodeCol] ?? "").trim();
      const price = String(vals[priceCol] ?? "").trim();
      if (barcode) rows.push({ barcode, price });
    });

    if (rows.length === 0 && (barcodeCol === -1 || priceCol === -1)) {
      const headerKeywords = [
        "barcode",
        "barcodes",
        "bar_code",
        "code",
        "price",
        "new_price",
        "newprice",
        "unit_price",
        "unit price",
      ];
      sheet.eachRow((row) => {
        const vals = row.values as unknown[];
        const firstCell = String(vals[1] ?? "")
          .toLowerCase()
          .trim();
        if (headerKeywords.includes(firstCell)) return;
        const barcode = String(vals[1] ?? "").trim();
        const price = String(vals[2] ?? "").trim();
        if (barcode) rows.push({ barcode, price });
      });
      if (rows.length === 0) {
        setPriceImportError(
          'Could not detect columns. Use headers "barcode" and "price", or put barcodes in column A and prices in column B.'
        );
        setPriceImportParsing(false);
        return;
      }
    }

    if (rows.length === 0) {
      setPriceImportError("No data rows found in the Excel file.");
      setPriceImportParsing(false);
      return;
    }

    pricePreviewMutation.mutate(rows);
  } catch (err) {
    setPriceImportError("Could not read Excel file: " + getErrorDetails(err).message);
  } finally {
    setPriceImportParsing(false);
  }
}
