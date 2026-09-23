import { forwardRef } from "react";
import type { WorkerRow } from "../types";

export interface AttendanceReportCounts {
  total: number;
  present: number;
  absent: number;
  other: number;
}

interface AttendanceReportImageProps {
  selectedDate: string;
  counts: AttendanceReportCounts;
  attendancePct: number;
  reportAbsentWorkers: WorkerRow[];
  notesMap: Record<number, string>;
}

/**
 * The off-screen attendance report that html2canvas renders into the WhatsApp
 * image: date, KPI strip and the absent-worker table.
 */
export const AttendanceReportImage = forwardRef<HTMLDivElement, AttendanceReportImageProps>(
  function AttendanceReportImage({ selectedDate, counts, attendancePct, reportAbsentWorkers, notesMap }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: "-12000px",
          top: 0,
          width: "1080px",
          background: "#111315",
          color: "#f4f4f5",
          padding: "28px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ marginBottom: "18px", display: "flex", justifyContent: "space-between", alignItems: "end" }}>
          <div>
            <div style={{ fontSize: "26px", fontWeight: 700 }}>Attendance Report</div>
            <div style={{ marginTop: "5px", color: "#a1a1aa", fontSize: "15px" }}>{selectedDate}</div>
          </div>
          <div style={{ color: "#a1a1aa", fontSize: "14px" }}>{counts.total} total workers</div>
        </div>

        <div
          data-testid="attendance-report-kpis"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "12px",
            marginBottom: "18px",
          }}
        >
          {[
            { key: "total", label: "Total", value: counts.total, border: "#34383e", valueColor: "#f4f4f5" },
            { key: "present", label: "Present", value: counts.present, border: "#14532d", valueColor: "#34d399" },
            { key: "absent", label: "Absent", value: counts.absent, border: "#7f1d1d", valueColor: "#f87171" },
            { key: "other", label: "Other", value: counts.other, border: "#78350f", valueColor: "#fbbf24" },
          ].map((kpi) => (
            <div
              key={kpi.key}
              data-testid={`attendance-report-kpi-${kpi.key}`}
              style={{
                minWidth: 0,
                border: `1px solid ${kpi.border}`,
                borderRadius: "12px",
                background: "#181a1e",
                padding: "15px 17px",
              }}
            >
              <div
                style={{
                  color: "#a1a1aa",
                  fontSize: "13px",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {kpi.label}
              </div>
              <div
                style={{
                  marginTop: "6px",
                  color: kpi.valueColor,
                  fontSize: "30px",
                  lineHeight: 1,
                  fontWeight: 800,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {kpi.value}
              </div>
            </div>
          ))}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "18px" }}>
          <thead>
            <tr style={{ background: "#292c31", color: "#f4f4f5" }}>
              <th style={{ width: "160px", padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>
                Code
              </th>
              <th style={{ padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>Worker</th>
              <th style={{ width: "150px", padding: "16px 14px", textAlign: "center", border: "1px solid #3f444b" }}>
                Status
              </th>
              <th style={{ width: "300px", padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {reportAbsentWorkers.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  style={{ padding: "30px 14px", textAlign: "center", color: "#a1a1aa", border: "1px solid #3f444b" }}
                >
                  No absent workers.
                </td>
              </tr>
            ) : (
              reportAbsentWorkers.map((worker, index) => (
                <tr
                  key={`attendance-report-${worker.id}`}
                  style={{ background: index % 2 === 0 ? "#111315" : "#181a1e" }}
                >
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                    {worker.employeeCode || "—"}
                  </td>
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e" }}>
                    <div dir="auto" style={{ fontWeight: 600 }}>
                      {worker.fullName}
                    </div>
                    <div style={{ marginTop: "4px", color: "#8b9098", fontSize: "13px" }}>
                      {worker.position || worker.department || "—"}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "15px 14px",
                      textAlign: "center",
                      border: "1px solid #34383e",
                      color: "#f87171",
                      fontWeight: 700,
                    }}
                  >
                    Absent
                  </td>
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                    {notesMap[worker.id] || "—"}
                  </td>
                </tr>
              ))
            )}
            <tr style={{ background: "#292c31" }}>
              <td colSpan={2} style={{ padding: "18px 14px", border: "1px solid #3f444b", fontWeight: 700 }}>
                Daily Total
              </td>
              <td
                style={{
                  padding: "14px",
                  textAlign: "center",
                  border: "1px solid #3f444b",
                  color: "#f87171",
                  fontWeight: 800,
                }}
              >
                {counts.absent} absent
              </td>
              <td style={{ padding: "14px", textAlign: "center", border: "1px solid #3f444b", fontWeight: 800 }}>
                {attendancePct}% present
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
);
