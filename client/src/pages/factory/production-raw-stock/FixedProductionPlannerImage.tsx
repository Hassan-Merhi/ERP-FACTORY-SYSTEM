import type { CSSProperties, RefObject } from "react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateFixedProductionPlanner } from "@/i18n/fixedProductionPlannerTranslations";
import type {
  FixedProductionPlanRow,
  FixedProductionPlanTotals,
} from "./fixedProductionPlannerCalculations";

interface PlannerImageProps {
  reportRef: RefObject<HTMLDivElement | null>;
  rows: FixedProductionPlanRow[];
  totals: FixedProductionPlanTotals;
  dateLabel: string;
}

const border = "1px solid #3d4349";
const numericCell: CSSProperties = {
  border,
  textAlign: "right",
  padding: "11px 14px",
  fontSize: "18px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  color: "#17202c",
};
const headerCell: CSSProperties = {
  ...numericCell,
  fontWeight: 800,
  fontSize: "15px",
  textAlign: "center",
  height: "72px",
};
const fmtQty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const fmtCoverage = (n: number) => n.toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function FixedProductionPlannerImage({ reportRef, rows, totals, dateLabel }: PlannerImageProps) {
  const { language } = useApplicationLanguage();
  const tr = (key: Parameters<typeof translateFixedProductionPlanner>[0]) => translateFixedProductionPlanner(key, language);
  return (
    // Must remain rendered, not display:none, so html2canvas can capture it.
    <div
      ref={reportRef}
      data-testid="fixed-production-planner-report-image"
      aria-hidden="true"
      style={{
        position: "fixed",
        left: "-15000px",
        top: "0px",
        zIndex: -1,
        pointerEvents: "none",
        width: "1320px",
        backgroundColor: "#ffffff",
        color: "#17202c",
        padding: "24px",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "18px" }}>
        <div style={{ fontWeight: 800, fontSize: "25px" }}>{tr("reportTitle")}</div>
        <div style={{ color: "#505b66", fontSize: "16px", fontWeight: 600 }}>{dateLabel}</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "20%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "17%" }} />
          <col style={{ width: "17%" }} />
          <col style={{ width: "13%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...headerCell, textAlign: "left", backgroundColor: "#f7ded4", paddingLeft: "14px" }}>{tr("reportOrigin")}</th>
            <th style={{ ...headerCell, backgroundColor: "#b5ddeb" }}>{tr("reportFifteenTons")}</th>
            <th style={{ ...headerCell, backgroundColor: "#94bcdf" }}>{tr("reportSeventeenTons")}</th>
            <th style={{ ...headerCell, backgroundColor: "#cee0f1" }}>{tr("reportTwentyTons")}</th>
            <th style={{ ...headerCell, backgroundColor: "#bbebbf" }}>{tr("reportWithOtw")}</th>
            <th style={{ ...headerCell, backgroundColor: "#d8d8d8" }}>{tr("reportWithoutOtw")}</th>
            <th style={{ ...headerCell, backgroundColor: "#eff6ea" }}>{tr("reportContainers")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ ...numericCell, textAlign: "left", backgroundColor: "#fffafa", fontWeight: 700 }}>{row.name}</td>
              <td style={{ ...numericCell, backgroundColor: "#b5ddeb" }}>{fmtQty(row.allocation15)}</td>
              <td style={{ ...numericCell, backgroundColor: "#94bcdf" }}>{fmtQty(row.allocation175)}</td>
              <td style={{ ...numericCell, backgroundColor: "#cee0f1" }}>{fmtQty(row.allocation20)}</td>
              <td style={{ ...numericCell, backgroundColor: "#bbebbf" }}>{fmtCoverage(row.withOtwDays)}</td>
              <td style={{ ...numericCell, backgroundColor: "#d8d8d8" }}>{fmtCoverage(row.withoutOtwDays)}</td>
              <td style={{ ...numericCell, backgroundColor: "#eff6ea" }}>{fmtCoverage(row.containersToOrder)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...numericCell, backgroundColor: "#f7ded4", textAlign: "left", fontWeight: 800 }}>{tr("planFor")}</td>
            <td style={{ ...numericCell, backgroundColor: "#b5ddeb", fontWeight: 800 }}>{fmtQty(totals.allocation15)}</td>
            <td style={{ ...numericCell, backgroundColor: "#94bcdf", fontWeight: 800 }}>{fmtQty(totals.allocation175)}</td>
            <td style={{ ...numericCell, backgroundColor: "#cee0f1", fontWeight: 800 }}>{fmtQty(totals.allocation20)}</td>
            <td style={{ ...numericCell, backgroundColor: "#bbebbf", fontWeight: 800 }}>{fmtCoverage(totals.withOtwDays)}</td>
            <td style={{ ...numericCell, backgroundColor: "#d8d8d8", fontWeight: 800 }}>{fmtCoverage(totals.withoutOtwDays)}</td>
            <td style={{ ...numericCell, backgroundColor: "#eff6ea", fontWeight: 800 }}>{fmtCoverage(totals.containersToOrder)}</td>
          </tr>
        </tfoot>
      </table>
      <div style={{ marginTop: "12px", fontSize: "13px", color: "#505b66" }}>
        {tr("reportFoot")}
      </div>
    </div>
  );
}
