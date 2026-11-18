/**
 * generateTransferImage.ts
 * Renders stock-transfer summary cards as PNG buffers using @napi-rs/canvas.
 * Rendered at 2× scale for crisp display on high-DPI screens (WhatsApp).
 */

import { createCanvas } from "@napi-rs/canvas";
import { clamp, fmtQty, roundRect, type RevisedTransferImageData } from "./generateTransferImageBuffer";
export { generateTransferImageBuffer } from "./generateTransferImageBuffer";
export type {
  RevisedTransferImageData,
  RevisedTransferItem,
  TransferImageData,
  TransferImageItem,
} from "./generateTransferImageBuffer";

// ── Revised Transfer card (amber) ────────────────────────────────────────────

export function generateRevisedTransferImageBuffer(data: RevisedTransferImageData): Promise<Buffer> {
  const SCALE = 2; // 2× for crisp HiDPI rendering
  const W = 472;
  const MARGIN = 16;
  const CARD_W = W - MARGIN * 2;
  const HEADER_H = 70;
  const ROUTE_H = 54;
  const ITEMS_HDR = 28;
  const ROW_H = 34;
  const FOOTER_H = 44;
  const CARD_H = HEADER_H + ROUTE_H + ITEMS_HDR + ROW_H * data.items.length + FOOTER_H;
  const TOTAL_H = CARD_H + MARGIN * 2;

  const AMBER = "#d97706";
  const AMBER_LT = "#fde68a";
  const AMBER_BG = "#fffbeb";
  const AMBER_TXT = "#92400e";
  const BLUE = "#2563eb";
  const RED = "#ef4444";
  const GREEN = "#059669";
  const SLATE_50 = "#f8fafc";
  const SLATE_200 = "#e2e8f0";
  const SLATE_400 = "#94a3b8";
  const SLATE_700 = "#334155";
  const SLATE_800 = "#1e293b";
  const WHITE = "#ffffff";
  const BG = "#fffbeb";

  // Canvas is physically 2× but we draw in logical units via scale()
  const canvas = createCanvas(W * SCALE, TOTAL_H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, TOTAL_H);

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.09)";
  roundRect(ctx, MARGIN + 2, MARGIN + 4, CARD_W, CARD_H, 16);
  ctx.fill();

  // Card
  ctx.fillStyle = WHITE;
  roundRect(ctx, MARGIN, MARGIN, CARD_W, CARD_H, 16);
  ctx.fill();

  let y = MARGIN;

  // ── Header ──────────────────────────────────────────────────────────────
  ctx.save();
  roundRect(ctx, MARGIN, y, CARD_W, CARD_H, 16);
  ctx.clip();

  ctx.fillStyle = AMBER;
  ctx.fillRect(MARGIN, y, CARD_W, HEADER_H);

  // Icon circle
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  roundRect(ctx, MARGIN + 16, y + 12, 28, 28, 8);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✎", MARGIN + 30, y + 26);

  // Title
  ctx.fillStyle = WHITE;
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("STOCK TRANSFER", MARGIN + 52, y + 22);

  // Revised badge
  ctx.fillStyle = AMBER_LT;
  ctx.font = "700 9px sans-serif";
  ctx.fillText("REVISED", MARGIN + 52, y + 38);

  // Date
  ctx.fillStyle = "#fef3c7";
  ctx.font = "500 11px sans-serif";
  ctx.fillText(`${data.date}  ·  ${data.voucherNumber}`, MARGIN + 16, y + 56);

  ctx.restore();
  y += HEADER_H;

  // ── Route ────────────────────────────────────────────────────────────────
  ctx.fillStyle = SLATE_50;
  ctx.fillRect(MARGIN, y, CARD_W, ROUTE_H);

  ctx.strokeStyle = SLATE_200;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y + ROUTE_H);
  ctx.lineTo(MARGIN + CARD_W, y + ROUTE_H);
  ctx.stroke();

  const COL_W = (CARD_W - 48) / 2;
  const AX = MARGIN + CARD_W / 2;

  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("FROM", MARGIN + 20, y + 12);
  ctx.fillStyle = SLATE_800;
  ctx.font = "700 14px sans-serif";
  ctx.fillText(clamp(ctx, data.sourceLocationName, COL_W - 8), MARGIN + 20, y + 26);

  ctx.fillStyle = AMBER_BG;
  ctx.beginPath();
  ctx.arc(AX, y + ROUTE_H / 2, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = AMBER;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("→", AX, y + ROUTE_H / 2);

  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("TO", MARGIN + CARD_W - 20, y + 12);
  ctx.fillStyle = SLATE_800;
  ctx.font = "700 14px sans-serif";
  ctx.fillText(clamp(ctx, data.destLocationName, COL_W - 8), MARGIN + CARD_W - 20, y + 26);

  y += ROUTE_H;

  // ── Items header ─────────────────────────────────────────────────────────
  const NAME_END = MARGIN + CARD_W - 178;
  const BEF_X = MARGIN + CARD_W - 138;
  const CHG_X = MARGIN + CARD_W - 88;
  const AFT_X = MARGIN + CARD_W - 42;
  const UOM_X2 = MARGIN + CARD_W - 16;

  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("ITEM", MARGIN + 20, y + ITEMS_HDR / 2);
  ctx.textAlign = "right";
  ctx.fillText("BEFORE", BEF_X, y + ITEMS_HDR / 2);
  ctx.fillText("CHANGE", CHG_X, y + ITEMS_HDR / 2);
  ctx.fillText("AFTER", AFT_X, y + ITEMS_HDR / 2);
  ctx.fillText("UNIT", UOM_X2, y + ITEMS_HDR / 2);

  ctx.strokeStyle = SLATE_200;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y + ITEMS_HDR);
  ctx.lineTo(MARGIN + CARD_W, y + ITEMS_HDR);
  ctx.stroke();

  y += ITEMS_HDR;

  // ── Item rows ────────────────────────────────────────────────────────────
  const NAME_MAX2 = NAME_END - (MARGIN + 20) - 8;

  data.items.forEach((item, idx) => {
    if (idx > 0) {
      ctx.strokeStyle = "#f1f5f9";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(MARGIN, y);
      ctx.lineTo(MARGIN + CARD_W, y);
      ctx.stroke();
    }

    const cy = y + ROW_H / 2;

    ctx.fillStyle = SLATE_700;
    ctx.font = "500 12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(clamp(ctx, item.name, NAME_MAX2), MARGIN + 20, cy);

    ctx.fillStyle = SLATE_400;
    ctx.font = "700 12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(fmtQty(item.before), BEF_X, cy);

    const deltaStr = item.delta > 0 ? `+${fmtQty(item.delta)}` : fmtQty(item.delta);
    ctx.fillStyle = item.delta > 0 ? GREEN : item.delta < 0 ? RED : SLATE_400;
    ctx.font = "800 13px sans-serif";
    ctx.fillText(deltaStr, CHG_X, cy);

    ctx.fillStyle = BLUE;
    ctx.font = "800 13px sans-serif";
    ctx.fillText(fmtQty(item.after), AFT_X, cy);

    ctx.fillStyle = SLATE_400;
    ctx.font = "600 10px sans-serif";
    ctx.fillText(item.uom, UOM_X2, cy);

    y += ROW_H;
  });

  // ── Footer ───────────────────────────────────────────────────────────────
  ctx.strokeStyle = AMBER_LT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(MARGIN + CARD_W, y);
  ctx.stroke();

  ctx.fillStyle = AMBER_BG;
  ctx.fillRect(MARGIN, y, CARD_W, FOOTER_H);

  // "REVISION" pill
  const PILL_X = MARGIN + 20;
  const PILL_Y = y + (FOOTER_H - 20) / 2;
  ctx.fillStyle = AMBER;
  roundRect(ctx, PILL_X, PILL_Y, 66, 20, 10);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = "800 9px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("REVISION", PILL_X + 33, PILL_Y + 10);

  ctx.fillStyle = AMBER_TXT;
  ctx.font = "700 13px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `${data.items.length} item${data.items.length !== 1 ? "s" : ""} revised`,
    MARGIN + CARD_W - 20,
    y + FOOTER_H / 2
  );

  return Promise.resolve(canvas.toBuffer("image/png") as unknown as Buffer);
}
