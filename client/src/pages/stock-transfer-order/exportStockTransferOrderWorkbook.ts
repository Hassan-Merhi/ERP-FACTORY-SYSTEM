import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { format } from "date-fns";
import { ExcelJS, writeFile } from "@/lib/excelHelper";
import type { Location, OrderItem } from "../stocktransferorder/types";

type ExportStockTransferOrderWorkbookInput = {
  orderItems: OrderItem[];
  locations: Location[];
  destinationLocationId: number | null;
  transferDate: Date;
  companyName: string;
  includeCost: boolean;
};

type ExportStockTransferOrderWorkbookResult = {
  fileName: string;
  itemCount: number;
};

export async function exportStockTransferOrderWorkbook({
  orderItems,
  locations,
  destinationLocationId,
  transferDate,
  companyName,
  includeCost,
}: ExportStockTransferOrderWorkbookInput): Promise<ExportStockTransferOrderWorkbookResult> {
  const destLocation = locations.find((location) => location.id === destinationLocationId);
  const exportDate = format(transferDate, "M/d/yy");
  const destName = destLocation?.name || "";

  const locationGroupMap = new Map<number, { locationName: string; items: OrderItem[] }>();
  for (const item of orderItems) {
    if (!locationGroupMap.has(item.sourceLocationId)) {
      locationGroupMap.set(item.sourceLocationId, {
        locationName: item.sourceLocationName,
        items: [],
      });
    }
    locationGroupMap.get(item.sourceLocationId)!.items.push(item);
  }
  const locationGroups = Array.from(locationGroupMap.entries()).map(([locationId, group]) => ({
    locationId,
    ...group,
  }));

  const numCols = includeCost ? 5 : 3;
  const lastColLetter = includeCost ? "E" : "C";
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Truck Trip");

  worksheet.pageSetup = {
    paperSize: 9,
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: {
      left: 0.4,
      right: 0.4,
      top: 0.4,
      bottom: 0.4,
      header: 0.2,
      footer: 0.2,
    },
  } as ExcelJS.PageSetup;

  worksheet.columns = [
    { width: 46 },
    { width: 20 },
    { width: 14 },
    ...(includeCost ? [{ width: 14 }, { width: 16 }] : []),
  ];

  const OLIVE_BG = "FF6B7A2C";
  const COL_HDR_BG = "FFD4E89E";
  const SUB_BG = "FFC6EFCE";
  const WHITE = "FFFFFFFF";
  const BLACK = "FF000000";
  const RED = "FFCC0000";

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFB0B0B0" } },
    left: { style: "thin", color: { argb: "FFB0B0B0" } },
    bottom: { style: "thin", color: { argb: "FFB0B0B0" } },
    right: { style: "thin", color: { argb: "FFB0B0B0" } },
  };

  const applyBorder = (row: ExcelJS.Row, columns: number) => {
    for (let column = 1; column <= columns; column += 1) {
      row.getCell(column).border = thinBorder;
    }
  };

  const row1 = worksheet.addRow([companyName, ...Array(numCols - 1).fill("")]);
  row1.height = 42;
  worksheet.mergeCells(`A1:${lastColLetter}1`);
  const row1Cell1 = row1.getCell(1);
  row1Cell1.value = companyName;
  row1Cell1.font = { bold: true, size: 20, color: { argb: WHITE } };
  row1Cell1.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: OLIVE_BG },
  };
  row1Cell1.alignment = { horizontal: "center", vertical: "middle" };
  row1Cell1.border = thinBorder;

  const row2 = worksheet.addRow(["TRUCK TRIP", "DESTINATION:", destName, ...(includeCost ? ["", ""] : [])]);
  row2.height = 26;
  if (numCols > 3) worksheet.mergeCells("A2:A3");
  const row2Cell1 = row2.getCell(1);
  row2Cell1.font = { bold: true, size: 16 };
  row2Cell1.alignment = { horizontal: "center", vertical: "middle" };
  row2Cell1.border = thinBorder;
  const row2Cell2 = row2.getCell(2);
  row2Cell2.font = { bold: true, size: 12 };
  row2Cell2.alignment = { horizontal: "right", vertical: "middle" };
  row2Cell2.border = thinBorder;
  const row2Cell3 = row2.getCell(3);
  row2Cell3.font = { bold: true, size: 12 };
  row2Cell3.alignment = { horizontal: "center", vertical: "middle" };
  row2Cell3.border = thinBorder;
  if (includeCost) {
    row2.getCell(4).border = thinBorder;
    row2.getCell(5).border = thinBorder;
  }

  const row3 = worksheet.addRow(["", "DATE :", exportDate, ...(includeCost ? ["", ""] : [])]);
  row3.height = 22;
  if (numCols === 3) row3.getCell(1).border = thinBorder;
  const row3Cell2 = row3.getCell(2);
  row3Cell2.font = { bold: true, size: 12 };
  row3Cell2.alignment = { horizontal: "right", vertical: "middle" };
  row3Cell2.border = thinBorder;
  const row3Cell3 = row3.getCell(3);
  row3Cell3.font = { bold: true, size: 12 };
  row3Cell3.alignment = { horizontal: "center", vertical: "middle" };
  row3Cell3.border = thinBorder;
  if (includeCost) {
    row3.getCell(4).border = thinBorder;
    row3.getCell(5).border = thinBorder;
  }
  if (numCols === 3) worksheet.mergeCells("A2:A3");

  const columnHeaders = ["ITEM  NAME", "LOCATION", "Quantity", ...(includeCost ? ["Rate", "Amount"] : [])];
  const row4 = worksheet.addRow(columnHeaders);
  row4.height = 22;
  for (let column = 1; column <= numCols; column += 1) {
    const cell = row4.getCell(column);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: COL_HDR_BG },
    };
    cell.font = { bold: true, size: 12, color: { argb: BLACK } };
    cell.alignment = {
      horizontal: column === 1 ? "left" : "center",
      vertical: "middle",
    };
    cell.border = thinBorder;
  }

  for (const group of locationGroups) {
    for (const item of group.items) {
      const values: (string | number)[] = [
        item.stockItemName,
        item.sourceLocationName,
        item.quantity,
        ...(includeCost ? [item.rate, item.quantity * item.rate] : []),
      ];
      const dataRow = worksheet.addRow(values);
      dataRow.height = 22;
      dataRow.getCell(1).font = { size: 12 };
      dataRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      dataRow.getCell(2).font = { size: 12 };
      dataRow.getCell(2).alignment = { horizontal: "center", vertical: "middle" };
      dataRow.getCell(3).font = { size: 12 };
      dataRow.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
      if (includeCost) {
        dataRow.getCell(4).font = { size: 12 };
        dataRow.getCell(4).numFmt = "#,##0.00";
        dataRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
        dataRow.getCell(5).font = { size: 12 };
        dataRow.getCell(5).numFmt = "#,##0.00";
        dataRow.getCell(5).alignment = { horizontal: "right", vertical: "middle" };
      }
      applyBorder(dataRow, numCols);
    }

    const groupQuantity = group.items.reduce((sum, item) => sum + item.quantity, 0);
    const groupAmount = group.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
    const subtotalValues: (string | number)[] = [
      `TOTAL ${group.locationName.toUpperCase()}`,
      "",
      groupQuantity,
      ...(includeCost ? ["", groupAmount] : []),
    ];
    const subtotalRow = worksheet.addRow(subtotalValues);
    subtotalRow.height = 24;
    worksheet.mergeCells(`A${subtotalRow.number}:B${subtotalRow.number}`);
    for (let column = 1; column <= numCols; column += 1) {
      const cell = subtotalRow.getCell(column);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: SUB_BG },
      };
      cell.font = { bold: true, size: 12, color: { argb: BLACK } };
      cell.border = thinBorder;
    }
    subtotalRow.getCell(1).alignment = {
      horizontal: "center",
      vertical: "middle",
    };
    subtotalRow.getCell(3).alignment = {
      horizontal: "center",
      vertical: "middle",
    };
    if (includeCost) {
      subtotalRow.getCell(5).numFmt = "#,##0.00";
      subtotalRow.getCell(5).alignment = {
        horizontal: "right",
        vertical: "middle",
      };
    }
  }

  const grandQuantity = orderItems.reduce((sum, item) => sum + item.quantity, 0);
  const grandAmount = orderItems.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const grandValues: (string | number)[] = ["TOTAL", "", grandQuantity, ...(includeCost ? ["", grandAmount] : [])];
  const grandRow = worksheet.addRow(grandValues);
  grandRow.height = 26;
  worksheet.mergeCells(`A${grandRow.number}:B${grandRow.number}`);
  for (let column = 1; column <= numCols; column += 1) {
    const cell = grandRow.getCell(column);
    cell.font = { bold: true, size: 14, color: { argb: RED } };
    cell.border = thinBorder;
  }
  grandRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  grandRow.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
  if (includeCost) {
    grandRow.getCell(5).numFmt = "#,##0.00";
    grandRow.getCell(5).alignment = {
      horizontal: "right",
      vertical: "middle",
    };
  }

  const safeDestinationName = destName.replace(/[/\\?%*:|"<>]/g, "_");
  const fileName = `Truck_Trip_${safeDestinationName}_${format(transferDate, "yyyy-MM-dd")}.xlsx`;
  styleSpecializedWorkbook(workbook, {
    expectedSheetNames: ["Truck Trip"],
    sheets: [{ name: "Truck Trip", purpose: "report" }],
  });
  await writeFile(workbook, fileName);

  return { fileName, itemCount: orderItems.length };
}
