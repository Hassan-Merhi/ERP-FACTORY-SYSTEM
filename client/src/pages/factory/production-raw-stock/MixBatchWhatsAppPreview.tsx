import type { CSSProperties, RefObject } from "react";
import { formatNumber } from "@/lib/formatNumber";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { mixBatchTargetTranslation } from "@/i18n/mixBatchCategoryTargetTranslations";
import {
  buildMixBatchCategoryReport,
  selectMixBatchTarget,
  type MixBatchSupplierCategory,
  type MixBatchSupplierCategoryLink,
} from "./mixBatchCategoryTargets";
import type { MixBatchPrintRow } from "./MixBatchList";

interface MixBatchWhatsAppPreviewProps {
  reportRef: RefObject<HTMLDivElement | null>;
  date: string;
  batches: MixBatchPrintRow[];
  categories: MixBatchSupplierCategory[];
  suppliers: MixBatchSupplierCategoryLink[];
  allocations: Record<string, number> | null;
}

const formatMoney = (n: number): string => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatWeight = (n: number): string => formatNumber(n, 3);
const formatRate = (n: number): string => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const cell: CSSProperties = { padding: "8px 6px", borderBottom: "1px solid #334155" };

/**
 * Shareable report only; does not modify a batch.
 * Category costs are summed from the persisted source costs returned by the
 * server. The average $/kg is total historical cost / actual kg, never the
 * simple arithmetic mean of supplier rates.
 */
export function MixBatchWhatsAppPreview({
  reportRef, date, batches, categories, suppliers, allocations,
}: MixBatchWhatsAppPreviewProps) {
  const { language } = useApplicationLanguage();
  const tr = (key: Parameters<typeof mixBatchTargetTranslation>[0], values?: Record<string, string | number>) => mixBatchTargetTranslation(key, language, values);
  return (
    <div
      ref={reportRef}
      aria-hidden="true"
      data-testid="mix-batch-category-whatsapp-image"
      style={{
        position: "fixed",
        left: "-12000px",
        top: 0,
        zIndex: -1,
        pointerEvents: "none",
        width: "1160px",
        padding: "24px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#f9fafb",
        backgroundColor: "#111827",
      }}
    >
      <div style={{ marginBottom: "18px", paddingBottom: "12px", borderBottom: "1px solid #334155" }}>
        <div style={{ fontSize: "13px", color: "#9ca3af" }}>{date}</div>
        <div style={{ marginTop: "4px", fontSize: "24px", fontWeight: 800 }}>{tr("reportTitle")}</div>
      </div>
      {(() => {
        // This is a date-based WhatsApp report. Aggregate all batches BEFORE
        // selecting the day's production tier; never apply one daily target
        // separately to every batch on the same date.
        const sourceRows = batches.flatMap(batch => batch.sources ?? []);
        const totalBatchWeight = batches.reduce((sum, batch) => sum + Number(batch.totalWeightKg || 0), 0);
        const tier = selectMixBatchTarget(totalBatchWeight);
        const rows = buildMixBatchCategoryReport(sourceRows, categories, allocations, suppliers, tier);
        const actualTotal = rows.reduce((sum, row) => sum + row.weightKg, 0);
        const historicalTotal = rows.reduce((sum, row) => sum + row.totalCost, 0);
        const targetTotal = rows.reduce((sum, row) => sum + (row.targetKg ?? 0), 0);
        const hasTargets = allocations !== null;
        const delta = hasTargets ? rows.reduce((sum, row) => sum + (row.differenceKg ?? 0), 0) : null;
        return (
          <section style={{ marginBottom: "28px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", marginBottom: "14px" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "14px", color: "#e2e8f0", fontWeight: 700 }}>
                  {batches.map(batch => batch.batchCode).join(" · ")}
                </div>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  {batches.length === 1 ? tr("batchesForDateOne") : tr("batchesForDateMany", { count: batches.length })}
                </div>
              </div>
              <span style={{ flexShrink: 0, padding: "6px 13px", borderRadius: "9px", backgroundColor: "#1d4ed8", color: "#fff", fontWeight: 800 }}>
                {tr("autoTarget", { ton: tier })}
              </span>
            </div>
            <div style={{ display: "flex", gap: "12px", marginBottom: "15px" }}>
              {[
                { label: tr("totalWeight"), value: formatWeight(actualTotal) + " kg" },
                { label: tr("recordedCost"), value: formatMoney(historicalTotal) },
                { label: tr("blendedCost"), value: formatRate(actualTotal > 0 ? historicalTotal / actualTotal : 0) },
              ].map(stat => (
                <div key={stat.label} style={{ flex: 1, borderRadius: "7px", padding: "10px 13px", backgroundColor: "#1f2937" }}>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>{stat.label}</div>
                  <div style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{stat.value}</div>
                </div>
              ))}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "26%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "12%" }} />
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: "#253246" }}>
                  {(["category", "actual", "average", "totalCost", "targetToday", "difference"] as const).map((key, idx) => (
                    <th key={key} style={{ ...cell, textAlign: idx === 0 ? "left" : "right", fontSize: "12px", color: "#cbd5e1" }}>{tr(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={row.id} style={{ backgroundColor: idx % 2 === 0 ? "#111827" : "#1c2939" }}>
                    <td style={{ ...cell, fontWeight: 700 }}>{row.id === "unmapped" ? tr("unknownSource") : row.id === "cat:uncategorized" ? tr("uncategorized") : row.name}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{formatWeight(row.weightKg)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{formatRate(row.averageCostPerKg)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{formatMoney(row.totalCost)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.targetKg === null ? "—" : formatWeight(row.targetKg)}</td>
                    <td style={{
                      ...cell, textAlign: "right", fontWeight: 800,
                      color: row.differenceKg === null ? "#94a3b8" : row.differenceKg < -0.0005 ? "#f87171" : row.differenceKg > 0.0005 ? "#4ade80" : "#e2e8f0",
                    }}>
                      {row.differenceKg === null ? "—" : row.differenceKg > 0 ? "+" + formatWeight(row.differenceKg) : formatWeight(row.differenceKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ backgroundColor: "#293548", fontWeight: 800 }}>
                  <td style={cell}>{tr("total")}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{formatWeight(actualTotal)}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{formatRate(actualTotal > 0 ? historicalTotal / actualTotal : 0)}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{formatMoney(historicalTotal)}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{hasTargets ? formatWeight(targetTotal) : "—"}</td>
                  <td style={{
                    ...cell, textAlign: "right", fontWeight: 800,
                    color: delta === null ? "#94a3b8" : delta < -0.0005 ? "#f87171" : delta > 0.0005 ? "#4ade80" : "#f9fafb",
                  }}>
                    {delta === null ? "—" : delta > 0 ? "+" + formatWeight(delta) : formatWeight(delta)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>
        );
      })()}
      <div style={{ borderTop: "1px solid #334155", marginTop: "12px", paddingTop: "12px", fontSize: "12px", color: "#9ca3af" }}>
        {tr("foot")}
        {!allocations && " " + tr("planMissing")}
      </div>
    </div>
  );
}
