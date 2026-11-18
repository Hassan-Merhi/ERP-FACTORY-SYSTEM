// Extracted from ./generateTransferImage.ts to keep that module under the source-size cap.
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TransferImageItem {
  name: string;
  quantity: number;
  uom: string;
}

export interface TransferImageData {
  voucherNumber: string;
  date: string;
  sourceLocationName: string;
  destLocationName: string;
  items: TransferImageItem[];
}

export interface RevisedTransferItem {
  name: string;
  uom: string;
  before: number;
  delta: number;
  after: number;
}

export interface RevisedTransferImageData {
  voucherNumber: string;
  date: string;
  sourceLocationName: string;
  destLocationName: string;
  items: RevisedTransferItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function clamp(ctx: SKRSContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// ── Transfer card (green) ────────────────────────────────────────────────────

export function generateTransferImageBuffer(data: TransferImageData): Promise<Buffer> {
  const SCALE = 2; // 2× for crisp HiDPI rendering
  const W = 452;
  const MARGIN = 16;
  const CARD_W = W - MARGIN * 2;
  const HEADER_H = 62;
  const ROUTE_H = 54;
  const ITEMS_HDR = 28;
  const ROW_H = 34;
  const FOOTER_H = 44;
  const CARD_H = HEADER_H + ROUTE_H + ITEMS_HDR + ROW_H * data.items.length + FOOTER_H;
  const TOTAL_H = CARD_H + MARGIN * 2;

  const GREEN = "#059669";
  const GREEN_LT = "#a7f3d0";
  const GREEN_BG = "#ecfdf5";
  const SLATE_50 = "#f8fafc";
  const SLATE_200 = "#e2e8f0";
  const SLATE_400 = "#94a3b8";
  const SLATE_700 = "#334155";
  const SLATE_800 = "#1e293b";
  const WHITE = "#ffffff";
  const BG = "#f0fdf4";

  // Canvas is physically 2× but we draw in logical units via scale()
  const canvas = createCanvas(W * SCALE, TOTAL_H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, TOTAL_H);

  // Card shadow
  ctx.fillStyle = "rgba(0,0,0,0.09)";
  roundRect(ctx, MARGIN + 2, MARGIN + 4, CARD_W, CARD_H, 16);
  ctx.fill();

  // Card white bg
  ctx.fillStyle = WHITE;
  roundRect(ctx, MARGIN, MARGIN, CARD_W, CARD_H, 16);
  ctx.fill();

  let y = MARGIN;

  // ── Header ──────────────────────────────────────────────────────────────
  ctx.save();
  roundRect(ctx, MARGIN, y, CARD_W, CARD_H, 16);
  ctx.clip();

  ctx.fillStyle = GREEN;
  ctx.fillRect(MARGIN, y, CARD_W, HEADER_H);

  // Icon circle
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  roundRect(ctx, MARGIN + 16, y + 14, 28, 28, 8);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("→", MARGIN + 30, y + 28);

  // Title
  ctx.fillStyle = WHITE;
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "1px";
  ctx.fillText("STOCK TRANSFER", MARGIN + 52, y + 24);
  ctx.letterSpacing = "0px";

  // Date · voucher
  ctx.fillStyle = GREEN_LT;
  ctx.font = "500 11px sans-serif";
  ctx.fillText(`${data.date}  ·  ${data.voucherNumber}`, MARGIN + 16, y + 48);

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

  // FROM
  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("FROM", MARGIN + 20, y + 12);
  ctx.fillStyle = SLATE_800;
  ctx.font = "700 14px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(clamp(ctx, data.sourceLocationName, COL_W - 8), MARGIN + 20, y + 26);

  // Arrow circle
  const AX = MARGIN + CARD_W / 2;
  ctx.fillStyle = GREEN_BG;
  ctx.beginPath();
  ctx.arc(AX, y + ROUTE_H / 2, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = GREEN;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("→", AX, y + ROUTE_H / 2);

  // TO
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
  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const ITEM_X = MARGIN + 20;
  const QTY_X = MARGIN + CARD_W - 84;
  const UOM_X = MARGIN + CARD_W - 20;
  ctx.fillText("ITEM", ITEM_X, y + ITEMS_HDR / 2);
  ctx.textAlign = "right";
  ctx.fillText("QTY", QTY_X, y + ITEMS_HDR / 2);
  ctx.fillText("UNIT", UOM_X, y + ITEMS_HDR / 2);

  ctx.strokeStyle = SLATE_200;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y + ITEMS_HDR);
  ctx.lineTo(MARGIN + CARD_W, y + ITEMS_HDR);
  ctx.stroke();

  y += ITEMS_HDR;

  // ── Item rows ────────────────────────────────────────────────────────────
  const NAME_MAX = QTY_X - ITEM_X - 12;

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
    ctx.fillText(clamp(ctx, item.name, NAME_MAX), ITEM_X, cy);

    ctx.fillStyle = GREEN;
    ctx.font = "800 14px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(fmtQty(item.quantity), QTY_X, cy);

    ctx.fillStyle = SLATE_400;
    ctx.font = "600 10px sans-serif";
    ctx.fillText(item.uom, UOM_X, cy);

    y += ROW_H;
  });

  // ── Footer ───────────────────────────────────────────────────────────────
  ctx.strokeStyle = SLATE_200;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(MARGIN + CARD_W, y);
  ctx.stroke();

  ctx.fillStyle = SLATE_50;
  ctx.fillRect(MARGIN, y, CARD_W, FOOTER_H);

  const totalQty = data.items.reduce((s, i) => s + i.quantity, 0);
  const uoms = [...new Set(data.items.map((i) => i.uom))];
  const uomLabel = uoms.length === 1 ? uoms[0] : "Mixed";

  ctx.fillStyle = SLATE_400;
  ctx.font = "700 9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("TOTAL ITEMS", ITEM_X, y + FOOTER_H / 2);

  ctx.fillStyle = GREEN;
  ctx.font = "800 20px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtQty(totalQty), MARGIN + CARD_W - 48, y + FOOTER_H / 2);

  ctx.fillStyle = SLATE_400;
  ctx.font = "600 11px sans-serif";
  ctx.fillText(uomLabel, MARGIN + CARD_W - 20, y + FOOTER_H / 2);

  return Promise.resolve(canvas.toBuffer("image/png") as unknown as Buffer);
}
