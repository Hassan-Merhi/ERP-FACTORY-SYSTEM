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
        width: "960px",
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
          <col style={{ width: "34%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "22%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...headerCell, textAlign: "left", backgroundColor: "#f7ded4", paddingLeft: "14px" }}>{tr("reportOrigin")}</th>
            <th style={{ ...headerCell, backgroundColor: "#b5ddeb" }}>{tr("reportFifteenTons")}</th>
            <th style={{ ...headerCell, backgroundColor: "#94bcdf" }}>{tr("reportSeventeenTons")}</th>
            <th style={{ ...headerCell, backgroundColor: "#cee0f1" }}>{tr("reportTwentyTons")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ ...numericCell, textAlign: "left", backgroundColor: "#fffafa", fontWeight: 700 }}>{row.name}</td>
              <td style={{ ...numericCell, backgroundColor: "#b5ddeb" }}>{fmtQty(row.allocation15)}</td>
              <td style={{ ...numericCell, backgroundColor: "#94bcdf" }}>{fmtQty(row.allocation175)}</td>
              <td style={{ ...numericCell, backgroundColor: "#cee0f1" }}>{fmtQty(row.allocation20)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...numericCell, backgroundColor: "#f7ded4", textAlign: "left", fontWeight: 800 }}>{tr("planFor")}</td>
            <td style={{ ...numericCell, backgroundColor: "#b5ddeb", fontWeight: 800 }}>{fmtQty(totals.allocation15)}</td>
            <td style={{ ...numericCell, backgroundColor: "#94bcdf", fontWeight: 800 }}>{fmtQty(totals.allocation175)}</td>
            <td style={{ ...numericCell, backgroundColor: "#cee0f1", fontWeight: 800 }}>{fmtQty(totals.allocation20)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
