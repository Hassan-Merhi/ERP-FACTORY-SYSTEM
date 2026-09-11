/**
 * Chatbot PO-import routes.
 *
 * AI-powered purchase-order file parsing and the confirm/import flow that
 * turns a parsed PO into purchase-order + line records. Extracted from
 * chatbotRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { upload } from "./_helpers";
import { extractPOFromText, clearERPContextCache } from "../chatService";
import { readExcel, sheetToJson } from "../excelHelper";
import { requireAIActionPermission, logAIAction } from "../lib/aiActionPermission";
import { poLineItems, purchaseOrders, supplierProformas } from "@shared/schema";
import { supplierService } from "./suppliers/supplierService";

export function registerChatbotPoImportRoutes(app: Express) {
  // ── PO File Parse (AI-powered) ────────────────────────────────────
  app.post("/api/chatbot/parse-po-file", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const denied = await requireAIActionPermission(req, "draft");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const fileExt = (req.file.originalname || "").toLowerCase().split(".").pop();
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
            rate: (item.rate || 0).toFixed(2),
            lineTotal: (item.quantity * (item.rate || 0)).toFixed(2),
          });
        }
        const itemsTotal = lines.reduce((s, l) => s + parseFloat(l.lineTotal), 0);
        const chargesNet =
          extracted.freight +
          extracted.surcharge +
          extracted.fumigation +
          extracted.documentCharges -
          extracted.discount +
          extracted.otherCharges;
        const grandTotal = itemsTotal + chargesNet;
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
          itemsTotal: itemsTotal.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
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
      const freight = parseFloat(col(first, "Freight", "freight") || "0") || 0;
      const surcharge = parseFloat(col(first, "Surcharge", "surcharge") || "0") || 0;
      const fumigation = parseFloat(col(first, "Fumigation", "fumigation") || "0") || 0;
      const documentCharges =
        parseFloat(
          col(first, "Document_Charges", "DocumentCharges", "Doc Charges", "DocCharges", "Document Charges") || "0"
        ) || 0;
      const discount = parseFloat(col(first, "Discount", "discount") || "0") || 0;
      const otherCharges = parseFloat(col(first, "Other_Charges", "OtherCharges", "Other Charges") || "0") || 0;

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
        const qty = parseFloat(col(row, "Quantity", "Qty", "quantity", "qty", "Units", "units") || "0");
        const rate = parseFloat(
          col(row, "Rate", "Price", "Unit_Price", "UnitPrice", "Unit Price", "rate", "price", "Unit Cost") || "0"
        );
        if ((!itemName && !itemCode) || qty <= 0) continue;
        const matched = await tryMatchItem(itemCode, itemName);
        mappedLines.push({
          rawName: itemName || itemCode,
          rawCode: itemCode || "",
          stockItemId: matched?.id ?? null,
          stockItemName: matched?.name ?? "",
          qty: qty.toString(),
          rate: rate.toFixed(2),
          lineTotal: (qty * rate).toFixed(2),
        });
      }

      // If standard mapping found items — use them directly
      if (mappedLines.length > 0) {
        const supplier = tryMatchSupplier(supplierCode) || tryMatchSupplier(supplierName);
        const itemsTotal = mappedLines.reduce((s, l) => s + parseFloat(l.lineTotal), 0);
        const chargesNet = freight + surcharge + fumigation + documentCharges - discount + otherCharges;
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
          itemsTotal: itemsTotal.toFixed(2),
          grandTotal: (itemsTotal + chargesNet).toFixed(2),
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
  });

  // ── PO Import Confirm ─────────────────────────────────────────────
  app.post("/api/chatbot/confirm-po-import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const denied = await requireAIActionPermission(req, "write");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const { poNumber, containerNumber, importDate, currency, supplierId, lines, charges } = req.body;

      if (!poNumber) return res.status(400).json({ message: "PO number is required" });
      if (!containerNumber) return res.status(400).json({ message: "Container number is required" });
      if (!supplierId) return res.status(400).json({ message: "Supplier is required" });
      if (!lines?.length) return res.status(400).json({ message: "At least one line item is required" });

      const visibleSuppliers = await supplierService.list(companyId, "", true);
      if (!visibleSuppliers.some((supplier) => supplier.id === Number(supplierId))) {
        return res.status(400).json({ message: "Supplier not found" });
      }

      const unresolved = lines.filter((l: { stockItemId?: unknown }) => !l.stockItemId);
      if (unresolved.length > 0) {
        return res.status(400).json({
          message: `${unresolved.length} item(s) still unresolved: ${unresolved.map((l: { rawName?: unknown; itemName?: unknown }) => l.rawName || l.itemName).join(", ")}`,
        });
      }

      // Duplicate PO number check
      const existingPO = await db
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.poNumber, poNumber), eq(purchaseOrders.companyId, companyId)))
        .limit(1);
      if (existingPO.length > 0) {
        return res.status(409).json({
          message: `A purchase order with number "${poNumber}" already exists. Please use a different PO number.`,
        });
      }

      // Get or create container
      let container = await storage.getContainerByNumber(containerNumber);
      if (!container) {
        container = await storage.createContainer({
          companyId,
          containerNumber,
          supplierId: Number(supplierId),
          status: "OTW",
          importDate: importDate || new Date().toISOString().split("T")[0],
        });
      } else {
        // Container-level duplicate check: prevent re-importing same container
        const existingPOs = await db
          .select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber })
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.containerId, container.id), eq(purchaseOrders.companyId, companyId)))
          .limit(5);

        if (existingPOs.length > 0) {
          return res.status(409).json({
            message: `Container "${containerNumber}" already has ${existingPOs.length} PO(s) imported (${existingPOs.map((p) => p.poNumber).join(", ")}). To avoid duplicates, please delete the existing POs first or use a different container number.`,
          });
        }
      }

      const itemsTotal = lines.reduce(
        (s: number, l: { qty: string; rate: string }) => s + parseFloat(l.qty) * parseFloat(l.rate),
        0
      );
      const freightAmt = parseFloat(charges?.freight || "0") || 0;
      const surchargeAmt = parseFloat(charges?.surcharge || "0") || 0;
      const fumigationAmt = parseFloat(charges?.fumigation || "0") || 0;
      const docChargesAmt = parseFloat(charges?.documentCharges || "0") || 0;
      const discountAmt = parseFloat(charges?.discount || "0") || 0;
      const otherChargesAmt = parseFloat(charges?.otherCharges || "0") || 0;
      const grandTotal =
        itemsTotal + freightAmt + surchargeAmt + fumigationAmt + docChargesAmt - discountAmt + otherChargesAmt;

      const po = await storage.createPurchaseOrder(
        {
          companyId,
          poNumber,
          containerId: container.id,
          supplierId: Number(supplierId),
          currency: currency || "USD",
          itemsTotal: itemsTotal.toFixed(2),
          freight: freightAmt.toFixed(2),
          surcharge: surchargeAmt.toFixed(2),
          fumigation: fumigationAmt.toFixed(2),
          documentCharges: docChargesAmt.toFixed(2),
          discount: discountAmt.toFixed(2),
          otherCharges: otherChargesAmt.toFixed(2),
          status: "Open",
          chargesEdited:
            freightAmt > 0 ||
            surchargeAmt > 0 ||
            fumigationAmt > 0 ||
            docChargesAmt > 0 ||
            discountAmt > 0 ||
            otherChargesAmt > 0,
        },
        importDate
      );

      for (const line of lines) {
        const q = parseFloat(line.qty);
        const r = parseFloat(line.rate);
        await db.insert(poLineItems).values({
          poId: po.id,
          stockItemId: Number(line.stockItemId),
          itemName: line.itemName || line.rawName || "Unknown Item",
          quantity: q.toFixed(3),
          rate: r.toFixed(2),
          lineTotal: (q * r).toFixed(2),
        });
      }

      // Fetch available proformas for the download-after-import offer
      const availableProformas = await db
        .select({ id: supplierProformas.id, reference: supplierProformas.reference })
        .from(supplierProformas)
        .where(and(eq(supplierProformas.companyId, companyId), eq(supplierProformas.supplierId, Number(supplierId))))
        .orderBy(desc(supplierProformas.createdAt));

      await logAIAction({
        req,
        actionType: "write",
        actionName: "po_import",
        inputJson: {
          poNumber,
          containerNumber,
          supplierId: Number(supplierId),
          lineCount: lines.length,
          currency: currency || "USD",
        },
        outputJson: { poId: po.id, containerId: container.id, grandTotal: grandTotal.toFixed(2) },
        status: "success",
        createdRecordId: po.id,
      });

      clearERPContextCache(companyId);
      res.json({
        success: true,
        poId: po.id,
        poNumber: po.poNumber,
        containerNumber,
        containerId: container.id,
        supplierId: Number(supplierId),
        lineCount: lines.length,
        itemsTotal: itemsTotal.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        crossCompany: !!(await storage.getParentCompanyId()),
        availableProformas,
      });
    } catch (error: unknown) {
      logger.error("PO import confirm error:", { error: error });
      res.status(500).json({ message: "Internal server error" });
    }
  });
}
