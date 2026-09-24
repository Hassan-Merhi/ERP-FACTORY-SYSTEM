import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Truck, Loader2, MessageCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { gitContainersUrl, groupBySupplier } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { STATUS_BADGE as STATUS_BADGE_MAP } from "./types";

export function TabTruckLocation() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [waSending, setWaSending] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all", includeOffloaded: true });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = data?.containers ?? [];
  const withTruck = allContainers.filter((r) => !!(r.numberPlate ?? "").trim());
  const noTruck = allContainers.filter((r) => !(r.numberPlate ?? "").trim());
  const shops = [...new Set(withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort();

  async function sendToWhatsApp() {
    if (!printRef.current) return;
    setWaSending(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const el = printRef.current;
      const sourceCanvas = await html2canvas(el, {
        scale: 1,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#f8fafc",
        logging: false,
        width: el.scrollWidth,
        height: el.scrollHeight,
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });

      const today = new Date().toISOString().substring(0, 10);
      const fileName = `TruckLocation_${today}.jpg`;
      // The API has a 2 MB JSON body limit. Base64 expands binary data by ~33%,
      // so enforce the actual serialized request size instead of estimating only
      // the decoded JPEG size. Keep headroom for middleware/proxy overhead.
      const MAX_JSON_BYTES = 1.55 * 1024 * 1024;
      const dimensionScales = [1, 0.86, 0.72, 0.6, 0.5];
      const qualities = [0.78, 0.64, 0.52, 0.42, 0.34];
      let imageBase64 = "";

      outer: for (const scale of dimensionScales) {
        let candidateCanvas = sourceCanvas;
        if (scale !== 1) {
          candidateCanvas = document.createElement("canvas");
          candidateCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
          candidateCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
          const context = candidateCanvas.getContext("2d");
          if (!context) continue;
          context.drawImage(sourceCanvas, 0, 0, candidateCanvas.width, candidateCanvas.height);
        }

        for (const quality of qualities) {
          const candidate = candidateCanvas.toDataURL("image/jpeg", quality);
          const payloadBytes = new TextEncoder().encode(
            JSON.stringify({ imageBase64: candidate, fileName })
          ).byteLength;
          if (payloadBytes <= MAX_JSON_BYTES) {
            imageBase64 = candidate;
            break outer;
          }
        }
      }

      if (!imageBase64) {
        toast({
          title: "Failed to send",
          description: "The tracking report is too large to fit in one WhatsApp image even after compression.",
          variant: "destructive",
        });
        return;
      }

      try {
        await apiRequest("POST", "/api/git/send-containers-whatsapp", {
          imageBase64,
          fileName,
        });
      } catch (apiErr) {
        const msg =
          getErrorDetails(apiErr).status === 413 ||
          String(getErrorDetails(apiErr).optionalMessage).toLowerCase().includes("too large")
            ? "Tracking report is still too large to send to WhatsApp."
            : (getErrorDetails(apiErr).optionalMessage ?? "Failed to send");
        toast({ title: "Failed to send", description: msg, variant: "destructive" });
        return;
      }

      toast({ title: "Sent", description: "Truck / Location report sent to WhatsApp group." });
    } catch (err) {
      toast({ title: "Failed to send", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setWaSending(false);
    }
  }

  const modeSelector = (
    <div className="max-sm:grid max-sm:grid-cols-2 flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground">Viewing:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        onClick={() => setCompanyMode("session")}
        data-testid="btn-truck-mode-session"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        onClick={() => setCompanyMode("all")}
        data-testid="btn-truck-mode-all"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-3">
        {modeSelector}
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3">
        {modeSelector}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="text-xs mt-0.5">{(error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        {modeSelector}
        <Button
          variant="outline"
          size="sm"
          onClick={sendToWhatsApp}
          disabled={waSending || withTruck.length === 0}
          data-testid="button-send-wa-truck-location"
        >
          {waSending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <MessageCircle className="h-4 w-4 mr-1.5" />
          )}
          {waSending ? "Sending…" : "Send to WhatsApp"}
        </Button>
      </div>

      <div className="flex gap-4 flex-wrap p-3 rounded-md border bg-muted/30 text-sm">
        <div className="flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground text-xs">With Truck:</span>
          <span className="font-bold">{withTruck.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">No Truck:</span>
          <span className="font-bold">{noTruck.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Shops:</span>
          <span className="font-bold">{shops.length}</span>
        </div>
      </div>

      {allContainers.length === 0 && (
        <div className="py-10 text-center text-muted-foreground text-sm">No active containers found.</div>
      )}

      {/* Always group by shop name across all companies — same merge logic as the WhatsApp print template */}
      {[{ id: 0, rows: withTruck }].map((cg) => {
        const cgShops = [...new Set(cg.rows.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
        );
        return (
          <div key={cg.id} className="space-y-1">
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-xs whitespace-nowrap border-collapse">
                <thead>
                  <tr className="bg-yellow-400 text-yellow-950 font-bold border-b-2 border-yellow-600">
                    <th className="py-1.5 px-3 text-center">CONTAINER #</th>
                    <th className="py-1.5 px-3 text-center">SUPPLIER</th>
                    <th className="py-1.5 px-3 text-center">NUMBER PLATE</th>
                    <th className="py-1.5 px-3 text-center">LOCATION</th>
                    <th className="py-1.5 px-3 text-center">AGENT</th>
                    <th className="py-1.5 px-3 text-center">TRANSPORTER</th>
                    <th className="py-1.5 px-3 text-center">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {cgShops.flatMap((shop) => {
                    const shopRows = cg.rows.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
                    const hdrRow = (
                      <tr key={`hdr-${cg.id}-${shop}`} className="bg-yellow-300 border-t border-yellow-500">
                        <td
                          colSpan={7}
                          className="py-1 px-3 font-bold text-yellow-900 text-center tracking-wide uppercase"
                        >
                          {shop} — {shopRows.length} container{shopRows.length !== 1 ? "s" : ""} on the road
                        </td>
                      </tr>
                    );
                    const supplierGroups = groupBySupplier(shopRows);
                    const hasMultiSupplier = supplierGroups.length > 1;
                    const dataRows = supplierGroups.flatMap(({ name: supName, rows: supRows }) => {
                      const supHdr = hasMultiSupplier ? (
                        <tr key={`sup-${cg.id}-${shop}-${supName}`} className="bg-muted/40 border-t border-border">
                          <td
                            colSpan={7}
                            className="py-0.5 px-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground"
                          >
                            {supName} — {supRows.length}
                          </td>
                        </tr>
                      ) : null;
                      const rows = supRows.map((r) => (
                        <tr key={r.id} className="border-b last:border-b-0 hover:bg-muted/40">
                          <td className="py-0.5 px-3 text-center font-mono font-semibold tracking-tight">
                            {r.containerNumber}
                          </td>
                          <td className="py-0.5 px-3 text-center">
                            {r.supplierCode ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-0.5 px-3 text-center font-mono">
                            {r.numberPlate ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-0.5 px-3 text-center">
                            {r.trackingLocation ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-0.5 px-3 text-center">
                            {r.agent ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-0.5 px-3 text-center">
                            {r.transporter ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-0.5 px-3 text-center">
                            <span
                              className={cn(
                                "px-1.5 py-0.5 rounded text-[10px] font-medium",
                                (STATUS_BADGE_MAP as Record<string, string>)[r.status] ?? "bg-muted text-foreground"
                              )}
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ));
                      return supHdr ? [supHdr, ...rows] : rows;
                    });
                    return [hdrRow, ...dataRows];
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* Hidden Full-HD print template for WhatsApp image capture */}
      <div
        ref={printRef}
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
          <div
            style={{ fontSize: "52px", fontWeight: 900, color: "#0f172a", letterSpacing: "-0.5px", lineHeight: 1.15 }}
          >
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
            {withTruck.length} Container{withTruck.length !== 1 ? "s" : ""} on the road
          </div>
        </div>

        {(() => {
          const allShops = [...new Set(withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
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
                  const shopRows = withTruck.filter((r) => (r.shopName ?? r.companyName ?? "Unknown") === shop);
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
    </div>
  );
}
