/** PDF rendering of the canonical factory invoice document. */
import fs from "fs";
import path from "path";
import { FACTORY_DOCUMENT_LABELS, applyFactoryPdfLanguage } from "./factoryDocumentLanguage";
import { FACTORY_INVOICE_EXTRA_LABELS } from "./factoryInvoiceTranslations";
import {
  CanonicalInvoiceDocument,
  InvoiceRenderOptions,
  buildCanonicalInvoiceFilename,
  buildInvoiceRenderGroups,
  currencySymbol,
  localizedLineCategory,
  localizedLineProduct,
  unitPriceLabel,
} from "./factoryInvoiceDocumentServiceModel";

function concatBuffers(chunks: Buffer[]): Buffer {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(output, offset);
    offset += chunk.length;
  }
  return output;
}

export async function buildCanonicalInvoicePdf(
  document: CanonicalInvoiceDocument,
  options: InvoiceRenderOptions = {}
): Promise<{ buffer: Buffer; fileName: string }> {
  const language = options.language ?? "en";
  const hideSelling = options.hideSelling === true;
  const noCharges = options.noCharges === true;
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 32, size: "A4", layout: "landscape", bufferPages: false });
  applyFactoryPdfLanguage(doc, language);

  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(concatBuffers(chunks)));
    doc.on("error", reject);
  });

  const pageLeft = 32;
  const pageRight = doc.page.width - 32;
  const usableWidth = pageRight - pageLeft;
  const rtl = language === "ar";
  const textAlign: "left" | "right" = rtl ? "right" : "left";
  const normalFont = () => {
    if (rtl) applyFactoryPdfLanguage(doc, language);
    else doc.font("Helvetica");
    return doc;
  };
  const boldFont = () => {
    if (rtl) applyFactoryPdfLanguage(doc, language);
    else doc.font("Helvetica-Bold");
    return doc;
  };
  const symbol = currencySymbol(document.baseCurrency);
  const money = (value: number) =>
    symbol === "CFA"
      ? `CFA ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const number = (value: number) =>
    value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const drawPageBranding = (firstPage: boolean) => {
    let y = 26;
    if (firstPage) {
      const logo = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(logo)) {
        try {
          doc.image(logo, (doc.page.width - 150) / 2, 18, { width: 150 });
          y = 82;
        } catch {
          y = 28;
        }
      }
    }
    boldFont()
      .fontSize(firstPage ? 14 : 10)
      .fillColor("#000000");
    doc.text(firstPage ? labels.invoice : `${labels.invoice} — ${document.invoiceNumber}`, pageLeft, y, {
      width: usableWidth,
      align: "center",
    });
    y = doc.y + 6;
    if (firstPage) {
      doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(0.5).strokeColor("#cccccc").stroke();
      y += 9;
      const leftMeta: Array<[string, string]> = [
        [labels.invoiceNo, document.invoiceNumber],
        [labels.customer, document.customerName || "-"],
        [labels.date, document.orderDate || "-"],
      ];
      const rightMeta: Array<[string, string]> = [
        [labels.container, document.containerNumber || "-"],
        [labels.destination, document.destination || "-"],
        [labels.status, document.status.replaceAll("_", " ")],
      ];
      normalFont().fontSize(8).fillColor("#000000");
      let metaY = y;
      for (let i = 0; i < Math.max(leftMeta.length, rightMeta.length); i++) {
        const left = leftMeta[i];
        const right = rightMeta[i];
        if (left) {
          boldFont().text(`${left[0]}: `, pageLeft, metaY, { continued: true, width: usableWidth / 2 - 10 });
          normalFont().text(left[1]);
        }
        if (right) {
          const rightX = pageLeft + usableWidth / 2;
          boldFont().text(`${right[0]}: `, rightX, metaY, {
            continued: true,
            width: usableWidth / 2,
            align: textAlign,
          });
          normalFont().text(right[1], { align: textAlign });
        }
        metaY += 13;
      }
      y = metaY + 4;
    } else {
      y += 3;
    }
    return y;
  };

  const columnDefs = hideSelling
    ? [
        { key: "index", title: "#", width: 28, align: "center" as const },
        { key: "code", title: labels.articleCode, width: 86, align: textAlign },
        { key: "product", title: labels.product, width: 240, align: textAlign },
        { key: "category", title: labels.category, width: 145, align: textAlign },
        { key: "qty", title: labels.quantity, width: 48, align: "right" as const },
        { key: "wtBale", title: labels.weightPerBale, width: 72, align: "right" as const },
        { key: "totalWt", title: labels.totalWeight, width: 78, align: "right" as const },
      ]
    : [
        { key: "index", title: "#", width: 26, align: "center" as const },
        { key: "code", title: labels.articleCode, width: 76, align: textAlign },
        { key: "product", title: labels.product, width: 185, align: textAlign },
        { key: "category", title: labels.category, width: 105, align: textAlign },
        { key: "qty", title: labels.quantity, width: 40, align: "right" as const },
        { key: "wtBale", title: labels.weightPerBale, width: 58, align: "right" as const },
        { key: "totalWt", title: labels.totalWeight, width: 64, align: "right" as const },
        { key: "price", title: unitPriceLabel(document, language), width: 78, align: "right" as const },
        { key: "total", title: labels.total, width: 82, align: "right" as const },
      ];

  const totalColumnWidth = columnDefs.reduce((sum, column) => sum + column.width, 0);
  const scale = usableWidth / totalColumnWidth;
  const columns = columnDefs.map((column) => ({ ...column, width: column.width * scale }));
  const drawTableHeader = (y: number) => {
    const height = 18;
    doc.rect(pageLeft, y, usableWidth, height).fill("#1F3864");
    boldFont().fillColor("#ffffff").fontSize(7.5);
    let x = pageLeft;
    for (const column of columns) {
      doc.text(column.title, x + 2, y + 5, {
        width: column.width - 4,
        align: column.align,
        lineBreak: false,
      });
      x += column.width;
    }
    normalFont().fillColor("#000000").fontSize(7.5);
    return y + height;
  };

  let y = drawTableHeader(drawPageBranding(true));
  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  let lineNumber = 0;
  let stripeIndex = 0;
  const renderGroups = buildInvoiceRenderGroups(document, language);

  for (const group of renderGroups) {
    for (const line of group.lines) {
      lineNumber += 1;
      totalQty += line.qty;
      totalWeight += line.totalWeight;
      totalAmount += line.totalPrice;
      const product = localizedLineProduct(line, language);
      const category = localizedLineCategory(line, language);
      const productHeight = doc.heightOfString(product, { width: columns[2].width - 4, align: textAlign });
      const categoryHeight = doc.heightOfString(category, { width: columns[3].width - 4, align: textAlign });
      const rowHeight = Math.max(16, Math.min(34, Math.max(productHeight, categoryHeight) + 6));

      if (y + rowHeight > doc.page.height - 42) {
        doc.addPage();
        y = drawTableHeader(drawPageBranding(false));
      }

      if (stripeIndex % 2 === 1) {
        doc.rect(pageLeft, y, usableWidth, rowHeight).fill("#F5F5F5");
        doc.fillColor("#000000");
      }
      stripeIndex += 1;

      const values: string[] = [
        String(lineNumber),
        line.articleCode,
        product,
        category,
        number(line.qty),
        number(line.weightPerBale),
        number(line.totalWeight),
        ...(hideSelling ? [] : [money(line.unitPrice), money(line.totalPrice)]),
      ];

      let x = pageLeft;
      values.forEach((value, columnIndex) => {
        const column = columns[columnIndex];
        doc.text(value, x + 2, y + 4, {
          width: column.width - 4,
          align: column.align,
          height: rowHeight - 6,
          ellipsis: true,
        });
        x += column.width;
      });
      y += rowHeight;
    }

    const subtotalHeight = 18;
    if (y + subtotalHeight > doc.page.height - 42) {
      doc.addPage();
      y = drawTableHeader(drawPageBranding(false));
    }

    doc.rect(pageLeft, y, usableWidth, subtotalHeight).fill("#F5F5F5");
    boldFont().fillColor("#1F3864").fontSize(8);
    const subtotalValues: string[] = [
      "",
      "",
      `${FACTORY_INVOICE_EXTRA_LABELS[language].subtotalPrefix} ${group.label}`,
      "",
      number(group.qty),
      "",
      number(group.totalWeight),
      ...(hideSelling
        ? []
        : [group.subtotalUnitPrice == null ? "" : money(group.subtotalUnitPrice), money(group.totalPrice)]),
    ];
    let subtotalX = pageLeft;
    subtotalValues.forEach((value, columnIndex) => {
      const column = columns[columnIndex];
      if (value) {
        doc.text(value, subtotalX + 2, y + 5, {
          width: column.width - 4,
          align: columnIndex === 2 ? "center" : column.align,
          lineBreak: false,
        });
      }
      subtotalX += column.width;
    });
    normalFont().fillColor("#000000").fontSize(7.5);
    y += subtotalHeight;
  }

  if (y + 20 > doc.page.height - 42) {
    doc.addPage();
    y = drawTableHeader(drawPageBranding(false));
  }
  doc.rect(pageLeft, y, usableWidth, 18).fill("#EEF2F9");
  boldFont().fillColor("#000000").fontSize(8);
  const totalValues: string[] = [
    "",
    "",
    labels.totals,
    "",
    number(totalQty),
    "",
    number(totalWeight),
    ...(hideSelling ? [] : ["", money(totalAmount)]),
  ];
  let totalX = pageLeft;
  totalValues.forEach((value, columnIndex) => {
    const column = columns[columnIndex];
    if (value) {
      doc.text(value, totalX + 2, y + 5, { width: column.width - 4, align: column.align, lineBreak: false });
    }
    totalX += column.width;
  });
  y += 26;

  if (!hideSelling && !noCharges) {
    const otherChargeLines = document.charges.filter((charge) => charge.chargeType !== "FREIGHT");
    const summaryRows: Array<[string, number, boolean]> = [
      [labels.subtotal, document.subtotalBales, false],
      ...(document.freightAmount > 0
        ? ([[labels.freight, document.freightAmount, false]] as Array<[string, number, boolean]>)
        : []),
      ...(otherChargeLines.length > 0
        ? otherChargeLines.map(
            (charge) => [charge.name || labels.otherCharges, charge.amount, false] as [string, number, boolean]
          )
        : document.otherChargesTotal > 0
          ? ([[labels.otherCharges, document.otherChargesTotal, false]] as Array<[string, number, boolean]>)
          : []),
      [labels.grandTotal, document.grandTotal, true],
    ];

    const boxWidth = 250;
    const boxX = pageRight - boxWidth;
    for (const [label, value, grand] of summaryRows) {
      if (y + 19 > doc.page.height - 36) {
        doc.addPage();
        y = drawPageBranding(false);
      }
      if (grand) {
        doc.rect(boxX, y, boxWidth, 19).fill("#1F3864");
        boldFont().fillColor("#ffffff").fontSize(9);
      } else {
        doc
          .moveTo(boxX, y + 18)
          .lineTo(pageRight, y + 18)
          .lineWidth(0.3)
          .strokeColor("#cccccc")
          .stroke();
        normalFont().fillColor("#000000").fontSize(8.5);
      }
      doc.text(label, boxX + 7, y + 5, { width: boxWidth * 0.58, align: textAlign, lineBreak: false });
      doc.text(money(value), boxX + boxWidth * 0.6, y + 5, {
        width: boxWidth * 0.37,
        align: "right",
        lineBreak: false,
      });
      y += 19;
    }
  }

  doc.end();
  const buffer = await completed;
  if (buffer.length < 5 || buffer.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new Error(FACTORY_INVOICE_EXTRA_LABELS.en.invalidPdf);
  }
  return { buffer, fileName: buildCanonicalInvoiceFilename(document, "pdf") };
}
