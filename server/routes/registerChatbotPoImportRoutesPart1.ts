// Extracted from ./chatbotPoImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { generalUploadLimitBytes, sizeLimitLabel } from "@shared/fileSizePolicy";
import { extractPOFromText } from "../chatService";
import { readExcel, sheetToJson } from "../excelHelper";
import { requireAIActionPermission } from "../lib/aiActionPermission";
import { supplierService } from "./suppliers/supplierService";
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, parseMoneyInput } from "../lib/money";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

/** Multipart upload: the only form part is the file (req.file), so no text fields. */
const parsePoFileInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

/** An amount read the way parseFloat read it, 0 when it does not parse (the old `|| 0`). */
export function amountOrZero(value: unknown): Decimal {
  return parseMoneyInput(value) ?? new MoneyDecimal(0);
}

/** Exact sum of preview line totals. */
function sumLineTotals(lines: Array<{ lineTotal: string }>): Decimal {
  return lines.reduce((sum, line) => sum.plus(amountOrZero(line.lineTotal)), new MoneyDecimal(0));
}

export function registerChatbotPoImportRoutesPart1(app: Express) {
  // ── PO File Parse (AI-powered) ────────────────────────────────────
  app.post(
    "/api/chatbot/parse-po-file",
    requireAuth,
    spreadsheetUpload.single("file"),
    validateRequest(parsePoFileInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const denied = await requireAIActionPermission(req, "draft");
        if (denied) return res.status(denied.code).json({ message: denied.message });

        const fileExt = (req.file.originalname || "").toLowerCase().split(".").pop();
        // This mixed AI endpoint accepts PDFs as well as spreadsheets. Keep the
        // stricter document/image policy even though the multipart parser permits
        // the role-aware Excel limit.
        if (!["xlsx", "xls", "csv", "ods"].includes(fileExt ?? "")) {
          const documentLimit = generalUploadLimitBytes(req.file.originalname, req.file.mimetype);
          if (req.file.size > documentLimit) {
            return res.status(413).json({
              code: "UPLOAD_FILE_TOO_LARGE",
              message: `File exceeds the ${sizeLimitLabel(documentLimit)} limit for this file type.`,
            });
          }
        }
        const allSuppliers = await supplierService.list(companyId, "", true);
        const allStockItems = await storage.getAllStockItems(companyId);

        // ── Helper: match supplier from raw string ──────────────────────
        function tryMatchSupplier(raw: string): { id: number; name: string } | null {
          if (!raw) return null;
          const lo = raw.toLowerCase();
          const byCode = allSuppliers.find((s) => s.code?.toLowerCase() === lo);
          if (byCode) return { id: byCode.id, name: byCode.legalName };
          const byName = allSuppliers.find(
            (s) => s.legalName.toLowerCase().includes(lo) || lo.includes(s.legalName.toLowerCase())
          );
          return byName ? { id: byName.id, name: byName.legalName } : null;
        }

        // ── Helper: match stock item ────────────────────────────────────
        async function tryMatchItem(code: string, name: string): Promise<{ id: number; name: string } | null> {
          if (code) {
            const si = await storage.getStockItemByCodeOrAlias(code, companyId as number);
            if (si) return { id: si.id, name: si.name };
          }
          if (name) {
            const lo = name.toLowerCase();
            const si = allStockItems.find((s) => s.name.toLowerCase() === lo || s.code?.toLowerCase() === lo);
            if (si) return { id: si.id, name: si.name };
          }
          return null;
        }

        // ── Helper: build response from extracted data ──────────────────
        async function buildResponse(extracted: {
          poNumber: string;
          containerNumber: string;
          supplierName: string;
          supplierCode: string;
          importDate: string;
          currency: string;
          items: { name: string; code: string; quantity: number; rate: number }[];
          freight: number;
          surcharge: number;
          fumigation: number;
          documentCharges: number;
          discount: number;
          otherCharges: number;
        }) {
          const supplier = tryMatchSupplier(extracted.supplierCode) || tryMatchSupplier(extracted.supplierName);
          const lines = [];
          for (const item of extracted.items) {
            if (item.quantity <= 0) continue;
            const matched = await tryMatchItem(item.code || "", item.name || "");
            lines.push({
              rawName: item.name || item.code || "Unknown",
              rawCode: item.code || "",
              stockItemId: matched?.id ?? null,
              stockItemName: matched?.name ?? "",
              qty: item.quantity.toString(),
              rate: moneyString(item.rate || 0),
              lineTotal: moneyString(amountOrZero(item.quantity).times(amountOrZero(item.rate || 0))),
            });
          }
          const itemsTotal = sumLineTotals(lines);
          const chargesNet = amountOrZero(extracted.freight)
            .plus(amountOrZero(extracted.surcharge))
            .plus(amountOrZero(extracted.fumigation))
            .plus(amountOrZero(extracted.documentCharges))
            .minus(amountOrZero(extracted.discount))
            .plus(amountOrZero(extracted.otherCharges));
          const grandTotal = itemsTotal.plus(chargesNet);
          const unresolvedItems = lines
            .map((l, i) => (l.stockItemId ? null : { index: i, rawName: l.rawName, rawCode: l.rawCode }))
            .filter(Boolean);

          return {
            poNumber: extracted.poNumber || "",
            containerNumber: extracted.containerNumber || "",
            importDate: extracted.importDate || new Date().toISOString().split("T")[0],
            currency: extracted.currency || "USD",
            supplierId: supplier?.id ?? null,
            supplierName: supplier?.name ?? (extracted.supplierCode || extracted.supplierName || ""),
            supplierRaw: extracted.supplierCode || extracted.supplierName || "",
            lines,
            charges: {
              freight: extracted.freight,
              surcharge: extracted.surcharge,
              fumigation: extracted.fumigation,
              documentCharges: extracted.documentCharges,
              discount: extracted.discount,
              otherCharges: extracted.otherCharges,
            },
            itemsTotal: moneyString(itemsTotal),
            grandTotal: moneyString(grandTotal),
            unresolvedSupplier: !supplier,
            unresolvedItems,
            allSuppliers: allSuppliers.map((s) => ({ id: s.id, name: s.legalName, code: s.code || "" })),
            allStockItems: allStockItems.map((s) => ({ id: s.id, name: s.name, code: s.code || "" })),
          };
        }

        // ── Flexible column lookup (Excel/CSV) ──────────────────────────
        function col(row: Record<string, unknown>, ...keys: string[]): string {
          for (const key of keys) {
            const norm = key.toLowerCase().replace(/[\s_]+/g, "");
            const found = Object.keys(row).find((k) => k.toLowerCase().replace(/[\s_]+/g, "") === norm);
            if (found !== undefined && row[found] != null && row[found] !== "") return String(row[found]).trim();
          }
          return "";
        }

        // ════════════════════════════════════════════════════════════════
        // PDF → always use AI extraction
        // ════════════════════════════════════════════════════════════════
        if (fileExt === "pdf") {
          let pdfText = "";
          try {
            const { PDFParse } = await import("pdf-parse");
            const parser = new PDFParse({ data: new Uint8Array(req.file.buffer) });
            try {
              const parsed = await parser.getText();
              pdfText = parsed.text;
            } finally {
              await parser.destroy();
            }
          } catch (pdfErr: unknown) {
            return res.status(400).json({ message: `Could not read PDF: ${getErrorMessage(pdfErr)}` });
          }
          if (!pdfText.trim())
            return res.status(400).json({ message: "PDF appears to be empty or is image-only (no extractable text)" });

          const extracted = await extractPOFromText(pdfText);
          if (!extracted || !extracted.items.length) {
            return res.status(400).json({
              message:
                "AI could not find any purchase order items in this PDF. Make sure the PDF contains readable text.",
            });
          }
          return res.json(await buildResponse(extracted));
        }

        // ════════════════════════════════════════════════════════════════
        // Excel / CSV → try column mapping first, AI fallback if needed
        // ════════════════════════════════════════════════════════════════
        let rows: Record<string, unknown>[] = [];
        if (fileExt === "csv") {
          const text = req.file.buffer.toString("utf-8");
          const csvLines = text.split(/\r?\n/).filter((l) => l.trim());
          if (csvLines.length < 2) return res.status(400).json({ message: "CSV file has no data rows" });
          const headers = csvLines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
          for (let i = 1; i < csvLines.length; i++) {
            const vals = csvLines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
            if (vals.every((v) => !v)) continue;
            const row: Record<string, unknown> = {};
            headers.forEach((h, idx) => {
              row[h] = vals[idx] ?? "";
            });
            rows.push(row);
          }
        } else {
          // Excel (.xlsx, .xls, .ods, etc.)
          let wb;
          try {
            wb = await readExcel(req.file.buffer);
          } catch (xlErr: unknown) {
            return res.status(400).json({ message: `Could not read file: ${getErrorMessage(xlErr)}` });
          }
          const sheetName = wb.SheetNames[0];
          if (!sheetName) return res.status(400).json({ message: "Excel file is empty" });
          rows = sheetToJson(wb.Sheets[sheetName]) as Record<string, unknown>[];
        }

        if (!rows.length) return res.status(400).json({ message: "File has no data rows" });

        // Try standard column mapping
        const first = rows[0];
        const poNumber = col(
          first,
          "PO_Number",
          "PONumber",
          "PO Number",
          "PO#",
          "po_number",
          "PONo",
          "PO No",
          "Invoice Number",
          "InvoiceNumber"
        );
        const containerNumber = col(
          first,
          "Container_Number",
          "ContainerNumber",
          "Container Number",
          "Container",
          "CONT",
          "Container#",
          "Shipment"
        );
        const supplierCode = col(first, "Supplier_Code", "SupplierCode", "Supplier Code", "Vendor Code", "VendorCode");
        const supplierName = col(first, "Supplier_Name", "SupplierName", "Supplier", "Vendor", "Vendor Name", "From");
        const currency = col(first, "Currency", "currency") || "USD";
        const importDateRaw = col(
          first,
          "Import_Date",
          "ImportDate",
          "Import Date",
          "Date",
          "PO_Date",
          "PODate",
          "Invoice Date",
          "Invoice_Date"
        );
        const importDate = importDateRaw || new Date().toISOString().split("T")[0];
        const freight = amountOrZero(col(first, "Freight", "freight")).toNumber();
        const surcharge = amountOrZero(col(first, "Surcharge", "surcharge")).toNumber();
        const fumigation = amountOrZero(col(first, "Fumigation", "fumigation")).toNumber();
        const documentCharges = amountOrZero(
          col(first, "Document_Charges", "DocumentCharges", "Doc Charges", "DocCharges", "Document Charges")
        ).toNumber();
        const discount = amountOrZero(col(first, "Discount", "discount")).toNumber();
        const otherCharges = amountOrZero(col(first, "Other_Charges", "OtherCharges", "Other Charges")).toNumber();

        const mappedLines = [];
        for (const row of rows) {
          const itemCode = col(
            row,
            "Item_Barcode",
            "ItemBarcode",
            "Barcode",
            "barcode",
            "Item_Code",
            "ItemCode",
            "Code",
            "SKU",
            "Item Code",
            "Barcode/Code"
          );
          const itemName = col(
            row,
            "Item_Name",
            "ItemName",
            "Name",
            "Description",
            "Item",
            "Product",
            "Item Description"
          );
          // A quantity that does not parse is skipped like a zero one; it used to
          // pass the "<= 0" check as NaN.
          const qty = amountOrZero(col(row, "Quantity", "Qty", "quantity", "qty", "Units", "units"));
          const rate = amountOrZero(
            col(row, "Rate", "Price", "Unit_Price", "UnitPrice", "Unit Price", "rate", "price", "Unit Cost")
          );
          if ((!itemName && !itemCode) || qty.lessThanOrEqualTo(0)) continue;
          const matched = await tryMatchItem(itemCode, itemName);
          mappedLines.push({
            rawName: itemName || itemCode,
            rawCode: itemCode || "",
            stockItemId: matched?.id ?? null,
            stockItemName: matched?.name ?? "",
            qty: qty.toString(),
            rate: moneyString(rate),
            lineTotal: moneyString(qty.times(rate)),
          });
        }

        // If standard mapping found items — use them directly
        if (mappedLines.length > 0) {
          const supplier = tryMatchSupplier(supplierCode) || tryMatchSupplier(supplierName);
          const itemsTotal = sumLineTotals(mappedLines);
          const chargesNet = amountOrZero(freight)
            .plus(amountOrZero(surcharge))
            .plus(amountOrZero(fumigation))
            .plus(amountOrZero(documentCharges))
            .minus(amountOrZero(discount))
            .plus(amountOrZero(otherCharges));
          const unresolvedItems = mappedLines
            .map((l, i) => (l.stockItemId ? null : { index: i, rawName: l.rawName, rawCode: l.rawCode }))
            .filter(Boolean);
          return res.json({
            poNumber,
            containerNumber,
            importDate,
            currency,
            supplierId: supplier?.id ?? null,
            supplierName: supplier?.name ?? (supplierCode || supplierName || ""),
            supplierRaw: supplierCode || supplierName || "",
            lines: mappedLines,
            charges: { freight, surcharge, fumigation, documentCharges, discount, otherCharges },
            itemsTotal: moneyString(itemsTotal),
            grandTotal: moneyString(itemsTotal.plus(chargesNet)),
            unresolvedSupplier: !supplier,
            unresolvedItems,
            allSuppliers: allSuppliers.map((s) => ({ id: s.id, name: s.legalName, code: s.code || "" })),
            allStockItems: allStockItems.map((s) => ({ id: s.id, name: s.name, code: s.code || "" })),
          });
        }

        // AI fallback — flatten rows to plain text and ask AI to parse
        const rawText = rows
          .map((r) =>
            Object.entries(r)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" | ")
          )
          .join("\n");
        const extracted = await extractPOFromText(rawText);
        if (!extracted || !extracted.items.length) {
          return res.status(400).json({
            message:
              "Could not find item rows in the file. Expected columns like Item_Name / Quantity / Rate, or the file may be in an unusual layout.",
            rowCount: rows.length,
            detectedColumns: Object.keys(rows[0] || {}),
          });
        }
        // Merge header-level fields we did find with AI-extracted items
        if (!extracted.poNumber && poNumber) extracted.poNumber = poNumber;
        if (!extracted.containerNumber && containerNumber) extracted.containerNumber = containerNumber;
        if (!extracted.supplierName && supplierName) extracted.supplierName = supplierName;
        if (!extracted.supplierCode && supplierCode) extracted.supplierCode = supplierCode;
        if (!extracted.importDate && importDateRaw) extracted.importDate = importDateRaw;
        return res.json(await buildResponse(extracted));
      } catch (error: unknown) {
        logger.error("PO file parse error:", { error: error });
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
