// Extracted from ./TabTruckLocation.tsx
import type { TabTruckLocationModel } from "./TabTruckLocationModel";

export function TabTruckLocationPrintReport({ m }: { m: TabTruckLocationModel }) {
  return (
    <div
      ref={m.printRef}
      style={{
        position: "absolute",
        left: "-9999px",
        top: 0,
        backgroundColor: "#f8fafc",
        color: "#1e293b",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        fontSize: "22px",
        width: "1600px",
        padding: "44px 48px 36px",
        boxSizing: "border-box",
      }}
      aria-hidden="true"
    >
      <div
        style={{
          textAlign: "center",
          marginBottom: "32px",
          paddingBottom: "24px",
          borderBottom: "5px solid #f59e0b",
        }}
      >
        <div style={{ fontSize: "52px", fontWeight: 900, color: "#0f172a", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          HMD International Group
        </div>
        <div
          style={{
            fontSize: "26px",
            fontWeight: 700,
            color: "#b45309",
            marginTop: "10px",
            letterSpacing: "1.2px",
            textTransform: "uppercase",
          }}
        >
          Truck / Location Status — Live Tracking Report
        </div>
        <div style={{ fontSize: "22px", color: "#475569", marginTop: "12px", fontWeight: 500 }}>
          {new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}
          {" · "}
          {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: "16px",
            padding: "10px 28px",
            backgroundColor: "#fef3c7",
            border: "2px solid #f59e0b",
            borderRadius: "28px",
            fontSize: "22px",
            fontWeight: 800,
            color: "#78350f",
          }}
        >
          {m.withTruck.length} Container{m.withTruck.length !== 1 ? "s" : ""} on the road
        </div>
      </div>

      {(() => {
        const allShops = [...new Set(m.withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
        );
        const cell: React.CSSProperties = {
          padding: "16px 14px",
          fontSize: "22px",
          overflow: "hidden",
          whiteSpace: "nowrap",
          borderBottom: "1px solid #cbd5e1",
          color: "#1e293b",
        };
        const hdrCols = [
          { label: "#", align: "center" as const },
          { label: "Container #", align: "center" as const },
          { label: "Supplier", align: "center" as const },
          { label: "Truck #", align: "center" as const },
          { label: "Location", align: "center" as const },
          { label: "Agent", align: "center" as const },
          { label: "Transporter", align: "center" as const },
          { label: "Status", align: "center" as const },
        ];
        return (
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "52px" }} />
              <col style={{ width: "270px" }} />
              <col style={{ width: "230px" }} />
              <col style={{ width: "210px" }} />
              <col style={{ width: "240px" }} />
              <col style={{ width: "180px" }} />
              <col style={{ width: "230px" }} />
              <col style={{ width: "92px" }} />
            </colgroup>
            <thead>
              <tr style={{ backgroundColor: "#1e3a5f" }}>
                {hdrCols.map((h) => (
                  <th
                    key={h.label}
                    style={{
                      padding: "18px 14px",
                      textAlign: h.align,
                      color: "#ffffff",
                      fontWeight: 700,
                      fontSize: "20px",
                      textTransform: "uppercase",
                      letterSpacing: "0.8px",
                    }}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allShops.flatMap((shop) => {
                const shopRows = m.withTruck.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
                let idx = 0;
                return [
                  <tr key={`hd-shop-${shop}`}>
                    <td
                      colSpan={8}
                      style={{
                        padding: "14px 16px",
                        backgroundColor: "#fef3c7",
                        fontWeight: 800,
                        color: "#78350f",
                        fontSize: "22px",
                        letterSpacing: "0.5px",
                        textAlign: "center",
                        textTransform: "uppercase",
                        borderTop: "3px solid #f59e0b",
                        borderBottom: "3px solid #f59e0b",
                      }}
                    >
                      {shop}
                      <span
                        style={{
                          fontWeight: 500,
                          color: "#92400e",
                          marginLeft: "14px",
                          fontSize: "19px",
                          textTransform: "none",
                        }}
                      >
                        ({shopRows.length} container{shopRows.length !== 1 ? "s" : ""})
                      </span>
                    </td>
                  </tr>,
                  ...shopRows.map((r) => {
                    idx++;
                    const rowBg = idx % 2 === 0 ? "#f1f5f9" : "#f8fafc";
                    return (
                      <tr key={`hd-row-${r.id}`} style={{ backgroundColor: rowBg }}>
                        <td style={{ ...cell, textAlign: "center", color: "#94a3b8", fontSize: "18px" }}>{idx}</td>
                        <td
                          style={{
                            ...cell,
                            textAlign: "center",
                            fontFamily: "monospace",
                            fontWeight: 700,
                            color: "#1d4ed8",
                          }}
                        >
                          {r.containerNumber}
                        </td>
                        <td style={{ ...cell, textAlign: "center", fontWeight: 500 }}>{r.supplierCode ?? "—"}</td>
                        <td
                          style={{
                            ...cell,
                            textAlign: "center",
                            fontFamily: "monospace",
                            fontWeight: 700,
                            color: "#6d28d9",
                          }}
                        >
                          {r.numberPlate ?? "—"}
                        </td>
                        <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: "#065f46" }}>
                          {r.trackingLocation ?? "—"}
                        </td>
                        <td style={{ ...cell, textAlign: "center", fontWeight: 500 }}>{r.agent ?? "—"}</td>
                        <td style={{ ...cell, textAlign: "center", color: "#92400e", fontWeight: 700 }}>
                          {r.transporter ?? "—"}
                        </td>
                        <td style={{ ...cell, textAlign: "center" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "6px 10px",
                              borderRadius: "5px",
                              fontSize: "17px",
                              fontWeight: 800,
                              backgroundColor: "#dbeafe",
                              color: "#1e40af",
                              textTransform: "uppercase",
                              letterSpacing: "0.6px",
                            }}
                          >
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        );
      })()}

      <div
        style={{
          marginTop: "28px",
          paddingTop: "18px",
          borderTop: "1px solid #cbd5e1",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontSize: "16px", color: "#64748b" }}>
          HMD International Group — ERP System — Auto-generated report
        </div>
        <div style={{ fontSize: "16px", color: "#64748b" }}>
          {new Date().toISOString().replace("T", " ").substring(0, 16)} UTC
        </div>
      </div>
    </div>
  );
}
