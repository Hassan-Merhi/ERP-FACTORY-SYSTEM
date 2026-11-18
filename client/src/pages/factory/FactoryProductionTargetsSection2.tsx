// Extracted from ./FactoryProductionTargets.tsx to keep that module under the source-size cap.
import { Fragment } from "react";
import { FACTORY_TRACKING_STATUSES } from "@/i18n/factoryStaffTrackingTranslations";
import { differenceText, statusTranslationKey } from "./factoryProductionTargetsModel";
import { useFactoryProductionTargetsState } from "./useFactoryProductionTargetsState";

export function FactoryProductionTargetsSection2({
  productionReportGroups,
  productionReportRef,
  referenceDate,
  rows,
  totals,
  tr,
}: Pick<
  ReturnType<typeof useFactoryProductionTargetsState>,
  "productionReportGroups" | "productionReportRef" | "referenceDate" | "rows" | "totals" | "tr"
>) {
  return (
    <div
      ref={productionReportRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: "-12000px",
        top: 0,
        width: "1280px",
        background: "#111315",
        color: "#f4f4f5",
        padding: "30px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "end" }}>
        <div>
          <div style={{ fontSize: "28px", fontWeight: 700 }}>{tr("productionTargets")}</div>
          <div style={{ marginTop: "6px", color: "#a1a1aa", fontSize: "16px" }}>{referenceDate}</div>
        </div>
        <div style={{ color: "#a1a1aa", fontSize: "15px" }}>
          {rows.length} {tr("people")}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "15px" }}>
        <thead>
          <tr style={{ background: "#292c31", color: "#f4f4f5" }}>
            <th style={{ width: "360px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
              {tr("worker")}
            </th>
            <th style={{ width: "260px", padding: "13px 10px", textAlign: "left", border: "1px solid #3f444b" }}>
              {tr("category")}
            </th>
            <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
              {tr("target")}
            </th>
            <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
              {tr("produced")}
            </th>
            <th style={{ width: "110px", padding: "13px 10px", textAlign: "right", border: "1px solid #3f444b" }}>
              {tr("difference")}
            </th>
            <th style={{ width: "130px", padding: "13px 10px", textAlign: "center", border: "1px solid #3f444b" }}>
              {tr("status")}
            </th>
          </tr>
        </thead>
        <tbody>
          {productionReportGroups.map((group) => (
            <Fragment key={`report-${group.label.toLocaleLowerCase() || "blank"}`}>
              <tr style={{ background: "#202328" }}>
                <td colSpan={6} style={{ padding: "11px 12px", border: "1px solid #3f444b", fontWeight: 700 }}>
                  {group.label || "—"}{" "}
                  <span style={{ marginLeft: "8px", color: "#a1a1aa", fontWeight: 400 }}>({group.rows.length})</span>
                </td>
              </tr>
              {group.rows.map((row, index) => {
                const members = row.displayMembers ?? [
                  {
                    personId: row.personId,
                    name: row.name,
                    code: row.code,
                    status: row.status,
                    active: row.active,
                  },
                ];
                return (
                  <tr
                    key={
                      row.linkGroupId != null
                        ? `production-report-link-${row.linkGroupId}`
                        : `production-report-worker-${row.personId}`
                    }
                    style={{ background: index % 2 === 0 ? "#111315" : "#181a1e" }}
                  >
                    <td dir="auto" style={{ padding: "12px 10px", border: "1px solid #34383e", fontWeight: 600 }}>
                      {members.map((member) => (
                        <div key={member.personId}>{member.name}</div>
                      ))}
                    </td>
                    <td style={{ padding: "12px 10px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                      {row.category || "—"}
                    </td>
                    <td
                      style={{
                        padding: "12px 10px",
                        textAlign: "right",
                        border: "1px solid #34383e",
                        fontWeight: 700,
                      }}
                    >
                      {row.targetBales ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "12px 10px",
                        textAlign: "right",
                        border: "1px solid #34383e",
                        fontWeight: 700,
                      }}
                    >
                      {row.producedBales ?? 0}
                    </td>
                    <td
                      style={{
                        padding: "12px 10px",
                        textAlign: "right",
                        border: "1px solid #34383e",
                        fontWeight: 700,
                      }}
                    >
                      {differenceText(row.targetBales, row.producedBales)}
                    </td>
                    <td
                      style={{
                        padding: "12px 10px",
                        textAlign: "center",
                        border: "1px solid #34383e",
                        fontWeight: 700,
                      }}
                    >
                      {members.map((member) => {
                        const statusColor =
                          member.status === FACTORY_TRACKING_STATUSES.absent
                            ? "#f87171"
                            : member.status === FACTORY_TRACKING_STATUSES.new
                              ? "#fbbf24"
                              : "#34d399";
                        return (
                          <div key={member.personId} style={{ color: statusColor }}>
                            {tr(statusTranslationKey(member.status))}
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
          <tr style={{ background: "#292c31" }}>
            <td
              colSpan={2}
              style={{ padding: "16px 12px", border: "1px solid #3f444b", fontWeight: 800, fontSize: "17px" }}
            >
              {tr("dailyTotal")}
            </td>
            <td
              style={{
                padding: "14px 10px",
                textAlign: "right",
                border: "1px solid #3f444b",
                fontWeight: 800,
                fontSize: "18px",
              }}
            >
              {totals.target}
            </td>
            <td
              style={{
                padding: "14px 10px",
                textAlign: "right",
                border: "1px solid #3f444b",
                fontWeight: 800,
                fontSize: "18px",
              }}
            >
              {totals.produced}
            </td>
            <td
              style={{
                padding: "14px 10px",
                textAlign: "right",
                border: "1px solid #3f444b",
                fontWeight: 800,
                fontSize: "18px",
              }}
            >
              {totals.difference > 0 ? `+${totals.difference}` : totals.difference}
            </td>
            <td
              style={{
                padding: "14px 10px",
                textAlign: "center",
                border: "1px solid #3f444b",
                fontWeight: 800,
                fontSize: "18px",
              }}
            >
              {rows.length}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
