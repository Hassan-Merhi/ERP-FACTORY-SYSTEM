// Extracted from ./retailLabels.tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type RetailLabelLayout = "thermal-50x30" | "thermal-58x40" | "a4-24";

export interface RetailLabelData {
  variantId: number;
  name: string;
  brand: string;
  color: string;
  size: string;
  barcode: string;
  sellingPrice: number;
  copies: number;
  isReprint?: boolean;
}

/** One entry the user wants a label for, with a suggested number of copies. */
export interface RetailLabelRequestItem {
  variantId: number;
  title: string;
  barcode: string;
  stockQuantity?: number;
  /** Number of units bought on a specific committed supplier purchase. */
  receivedQuantity?: number;
}

export const RETAIL_LABEL_LAYOUTS: Array<{ id: RetailLabelLayout; title: string; hint: string }> = [
  { id: "thermal-50x30", title: "Thermal 50 × 30 mm", hint: "Clothing tag roll, one label per tag" },
  { id: "thermal-58x40", title: "Thermal 58 × 40 mm", hint: "Larger roll labels" },
  { id: "a4-24", title: "A4 sheet · 24 labels (70 × 37 mm)", hint: "Office printer label sheets" },
];

export const LAYOUT_STORAGE_KEY = "retail-label-layout";

export const PRICE_STORAGE_KEY = "retail-label-show-price";

export function readPreference(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience only.
  }
}

const PAGE_CSS: Record<RetailLabelLayout, string> = {
  "thermal-50x30": "@page { size: 50mm 30mm; margin: 0; }",
  "thermal-58x40": "@page { size: 58mm 40mm; margin: 0; }",
  "a4-24": "@page { size: A4; margin: 0; }",
};

const LABEL_CSS = `
#retail-label-print-root { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
#retail-label-print-root .rl-label { box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; background: #fff; }
#retail-label-print-root .rl-top { display: flex; justify-content: space-between; gap: 1mm; font-weight: 700; line-height: 1.1; }
#retail-label-print-root .rl-brand { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-transform: uppercase; }
#retail-label-print-root .rl-price { white-space: nowrap; }
#retail-label-print-root .rl-style { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; line-height: 1.15; }
#retail-label-print-root .rl-variant { font-weight: 700; line-height: 1.15; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#retail-label-print-root .rl-code { position: relative; flex: 1 1 auto; min-height: 0; margin-top: 0.6mm; }
#retail-label-print-root .rl-code img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#retail-label-print-root .rl-digits { font-family: "Courier New", monospace; text-align: center; letter-spacing: 0.4mm; line-height: 1.1; }
#retail-label-print-root .layout-thermal-50x30 .rl-label { width: 50mm; height: 30mm; padding: 1.4mm 3.5mm 1mm; page-break-after: always; break-after: page; }
#retail-label-print-root .layout-thermal-50x30 .rl-top, #retail-label-print-root .layout-thermal-50x30 .rl-variant { font-size: 7.5pt; }
#retail-label-print-root .layout-thermal-50x30 .rl-style { font-size: 6.5pt; }
#retail-label-print-root .layout-thermal-50x30 .rl-digits { font-size: 7pt; }
#retail-label-print-root .layout-thermal-58x40 .rl-label { width: 58mm; height: 40mm; padding: 2mm 4mm 1.5mm; page-break-after: always; break-after: page; }
#retail-label-print-root .layout-thermal-58x40 .rl-top, #retail-label-print-root .layout-thermal-58x40 .rl-variant { font-size: 9pt; }
#retail-label-print-root .layout-thermal-58x40 .rl-style { font-size: 8pt; }
#retail-label-print-root .layout-thermal-58x40 .rl-digits { font-size: 8.5pt; }
#retail-label-print-root .layout-a4-24 { display: grid; grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37.1mm; padding: 0; }
#retail-label-print-root .layout-a4-24 .rl-label { width: 70mm; height: 37.1mm; padding: 2.5mm 5mm 2mm; break-inside: avoid; }
#retail-label-print-root .layout-a4-24 .rl-top, #retail-label-print-root .layout-a4-24 .rl-variant { font-size: 9pt; }
#retail-label-print-root .layout-a4-24 .rl-style { font-size: 8pt; }
#retail-label-print-root .layout-a4-24 .rl-digits { font-size: 9pt; }
@media screen { #retail-label-print-root { display: none; } }
@media print {
  html, body { background: #fff !important; }
  body > *:not(#retail-label-print-root) { display: none !important; }
  #retail-label-print-root { display: block; }
  #retail-label-print-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

const svgCache = new Map<string, string>();

/** Fetches the server-rendered Code 128 SVG as a data URL that stretches to fill the label width. */
export async function loadBarcodeSvg(barcode: string): Promise<string> {
  const cached = svgCache.get(barcode);
  if (cached) return cached;
  const response = await fetch(`/api/barcode/${encodeURIComponent(barcode)}?format=svg`, { credentials: "include" });
  const text = await response.text();
  if (!response.ok || !text.trimStart().startsWith("<svg")) throw new Error(`Could not render barcode ${barcode}`);
  const svg = text.replace(/<svg\b/, '<svg preserveAspectRatio="none"');
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  svgCache.set(barcode, dataUrl);
  return dataUrl;
}

function formatPrice(value: number, currency?: string | null) {
  const amount = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value || 0
  );
  return currency ? `${amount} ${currency}` : amount;
}

export function RetailLabelSheet({
  labels,
  layout,
  showPrice,
  currency,
  svgs,
}: {
  labels: RetailLabelData[];
  layout: RetailLabelLayout;
  showPrice: boolean;
  currency?: string | null;
  svgs: Record<string, string>;
}) {
  const copies = labels.flatMap((label) => Array.from({ length: label.copies }, (_, index) => ({ label, index })));
  return (
    <div className={`layout-${layout}`} data-no-translate>
      {copies.map(({ label, index }) => (
        <div className="rl-label" key={`${label.variantId}-${index}`} data-testid="retail-label">
          <div className="rl-top">
            <span className="rl-brand">{label.brand}</span>
            {showPrice && <span className="rl-price">{formatPrice(label.sellingPrice, currency)}</span>}
          </div>
          <div className="rl-style">{label.name}</div>
          <div className="rl-variant">
            {label.color} · {label.size}
          </div>
          <div className="rl-code">{svgs[label.barcode] && <img src={svgs[label.barcode]} alt={label.barcode} />}</div>
          <div className="rl-digits">{label.barcode}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders labels into a print-only portal and opens the browser print dialog.
 * Works with any printer the OS exposes (thermal roll printers or A4 sheets).
 */
export function useRetailLabelPrinter() {
  const [job, setJob] = useState<{
    labels: RetailLabelData[];
    layout: RetailLabelLayout;
    showPrice: boolean;
    currency?: string | null;
    svgs: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    if (!job) return;
    const style = document.createElement("style");
    style.setAttribute("data-retail-label-print", "true");
    style.textContent = `${LABEL_CSS}\n@media print { ${PAGE_CSS[job.layout]} }`;
    document.head.appendChild(style);
    const finish = () => setJob(null);
    window.addEventListener("afterprint", finish, { once: true });
    const timer = window.setTimeout(() => window.print(), 150);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      style.remove();
    };
  }, [job]);

  const print = async (
    labels: RetailLabelData[],
    layout: RetailLabelLayout,
    showPrice: boolean,
    currency?: string | null
  ) => {
    const unique = [...new Set(labels.map((label) => label.barcode))];
    const entries = await Promise.all(unique.map(async (barcode) => [barcode, await loadBarcodeSvg(barcode)] as const));
    setJob({ labels, layout, showPrice, currency, svgs: Object.fromEntries(entries) });
  };

  const portal = job
    ? createPortal(
        <div id="retail-label-print-root">
          <RetailLabelSheet {...job} />
        </div>,
        document.body
      )
    : null;

  return { print, portal, printing: Boolean(job) };
}
