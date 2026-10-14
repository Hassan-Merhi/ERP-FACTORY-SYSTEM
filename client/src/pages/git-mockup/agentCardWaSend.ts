import { getErrorDetails } from "@shared/errorUtils";
import { fmt, fmtD, clientReallocate } from "./helpers";
import type { AgentDutySummary, ApiAllocatedRow, ApiAllocStatus } from "./types";

interface AdjEntry {
  id: number;
  description: string;
  amount: number;
  type: string;
}

export interface SendAgentDutyWaParams {
  agent: AgentDutySummary;
  customOrder: number[] | null;
  dbPrepaidIds: number[];
  adjustments: AdjEntry[];
  transitTransporterFilter: string | null;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  setWaSending: (b: boolean) => void;
}

export async function sendAgentCardToWhatsApp(params: SendAgentDutyWaParams): Promise<void> {
  const { agent, customOrder, dbPrepaidIds, adjustments, transitTransporterFilter, toast, setWaSending } = params;
  setWaSending(true);
  try {
    const html2canvas = (await import("html2canvas")).default;
    const esc = (s: unknown) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    const agentName = agent.agentName;
    const ledgerBalance = agent.ledgerBalance;
    const hasBalance = ledgerBalance !== null;
    const activePreviewRows = agent.activePreviewRows.filter((r) => !!(r.numberPlate ?? "").trim());
    const cbClearedRows = agent.clearedRows as ApiAllocatedRow[];
    const cbAllOpenPartial: ApiAllocatedRow[] = [
      ...(agent.partialRows as ApiAllocatedRow[]),
      ...(agent.openRows as ApiAllocatedRow[]),
    ];
    const cbClearedTotal = cbClearedRows.reduce((s, r) => s + r.dutyFee, 0);
    const cbRemainder = Math.max(agent.clearedByPayments - cbClearedTotal, 0);
    let openAndPartial: ApiAllocatedRow[];
    if (customOrder && customOrder.length > 0) {
      const orderMap = new Map(customOrder.map((id, i) => [id, i]));
      const sorted = [...cbAllOpenPartial].sort((a, b) => {
        const ai = orderMap.has(a.id)
          ? orderMap.get(a.id)!
          : customOrder.length + cbAllOpenPartial.findIndex((r) => r.id === a.id);
        const bi = orderMap.has(b.id)
          ? orderMap.get(b.id)!
          : customOrder.length + cbAllOpenPartial.findIndex((r) => r.id === b.id);
        return ai - bi;
      });
      openAndPartial = clientReallocate(sorted, cbRemainder);
    } else {
      openAndPartial = clientReallocate(cbAllOpenPartial, cbRemainder);
    }

    const thOpen = (bg = "#334155") =>
      `padding:6px 8px;font-size:10.5px;font-weight:700;text-align:center;letter-spacing:0.04em;` +
      `background:${bg};color:#f1f5f9;border:1px solid rgba(0,0,0,0.2);white-space:nowrap;text-transform:uppercase;`;
    const tdOpen = (align = "left", bold = false, color = "#111827") =>
      `font-size:10.5px;padding:5px 8px;text-align:${align};color:${color};` +
      `font-weight:${bold ? "700" : "400"};border:1px solid #e5e7eb;white-space:nowrap;`;
    const thTransit = (bg = "#475569") =>
      `padding:7px 10px;font-size:11px;font-weight:700;text-align:center;letter-spacing:0.04em;` +
      `background:${bg};color:#f8fafc;border:1px solid rgba(0,0,0,0.2);white-space:nowrap;text-transform:uppercase;`;
    const tdTransit = (align = "left", bold = false, color = "#1e293b") =>
      `font-size:11px;padding:6px 10px;text-align:${align};color:${color};` +
      `font-weight:${bold ? "700" : "400"};border:1px solid #e2e8f0;white-space:nowrap;`;

    const netAdj = adjustments.reduce((s, a) => s + (a.type === "debit" ? a.amount : -a.amount), 0);
    const hasAdj = adjustments.length > 0;
    const waOpenSum = openAndPartial.reduce((s, r) => s + r.remainingAmount, 0);
    const displayBal = ledgerBalance ?? waOpenSum;
    const adjustedBal = displayBal;
    const adjIsDebit = adjustedBal >= 0;
    const isReconciledWa = hasAdj && hasBalance && Math.abs(adjustedBal) <= 0.01;

    const waPrepaidSet = new Set<number>(dbPrepaidIds);
    const waPrepaidRows = activePreviewRows.filter((r) => waPrepaidSet.has(r.id));
    const waRemainingRows = activePreviewRows.filter((r) => !waPrepaidSet.has(r.id));
    const designatedPrepaidSum = waPrepaidRows.reduce((s: number, r) => s + Number(r.dutyFee ?? 0), 0);
    const waPrepaidBudget = Math.max(0, ledgerBalance ?? 0);
    const minOpenRem =
      cbAllOpenPartial.length > 0
        ? Math.min(...cbAllOpenPartial.map((r) => r.remainingAmount).filter((a) => a > 0.01))
        : Infinity;
    const allBudgetDesignated =
      designatedPrepaidSum > 0 &&
      waPrepaidBudget > 0 &&
      (designatedPrepaidSum >= waPrepaidBudget - 0.01 ||
        waPrepaidBudget - designatedPrepaidSum <= (isFinite(minOpenRem) ? minOpenRem : 0) ||
        Math.abs(designatedPrepaidSum + netAdj - waPrepaidBudget) <= 1.0);
    const enhancedRem = allBudgetDesignated
      ? (agent.offloadedDutyTotal ?? 0) * 2 + 1
      : cbRemainder + designatedPrepaidSum;
    let _waEnhRem = enhancedRem;
    const enhancedAllocated = openAndPartial.map((row: ApiAllocatedRow) => {
      const needed = row.remainingAmount;
      if (needed <= 0) return { ...row, allocationStatus: "Cleared" as ApiAllocStatus };
      if (_waEnhRem >= needed) {
        _waEnhRem -= needed;
        return {
          ...row,
          clearedAmount: row.dutyFee,
          remainingAmount: 0,
          allocationStatus: "Cleared" as ApiAllocStatus,
        };
      } else if (_waEnhRem > 0) {
        const extra = _waEnhRem;
        _waEnhRem = 0;
        return {
          ...row,
          clearedAmount: row.clearedAmount + extra,
          remainingAmount: row.remainingAmount - extra,
          allocationStatus: "Partially Cleared" as ApiAllocStatus,
        };
      }
      return row;
    });
    const enhancedCoveredIds = new Set(
      enhancedAllocated.filter((r: ApiAllocatedRow) => r.clearedAmount >= r.dutyFee).map((r: ApiAllocatedRow) => r.id)
    );
    const waVisibleOpenPartial = openAndPartial.filter((r: ApiAllocatedRow) => !enhancedCoveredIds.has(r.id));

    let openRowsHtml = "";
    const totalTopRows = waPrepaidRows.length + waVisibleOpenPartial.length;
    if (totalTopRows === 0) {
      openRowsHtml = `<tr><td colspan="11" style="padding:16px;text-align:center;color:#6b7280;font-style:italic;font-size:11px;border:1px solid #e5e7eb;">No open containers — account fully cleared.</td></tr>`;
    } else if (isReconciledWa && waPrepaidRows.length === 0) {
      openRowsHtml = `<tr><td colspan="11" style="padding:16px;text-align:center;color:#065f46;font-style:italic;font-size:11px;border:1px solid #a7f3d0;background:#d1fae5;">All containers reconciled by manual entries — no outstanding balance.</td></tr>`;
    } else {
      waPrepaidRows.forEach((r) => {
        openRowsHtml += `<tr style="background:#d1fae5">
          <td style="${tdOpen("left", true)}">${esc(r.containerNumber)}</td>
          <td style="${tdOpen()}">${esc(r.supplierCode ?? r.supplierName ?? "—")}</td>
          <td style="${tdOpen()}">${esc(r.numberPlate ?? "—")}</td>
          <td style="${tdOpen("center", false, "#059669")};font-style:italic;">In Transit</td>
          <td style="${tdOpen()}">${esc(fmtD(r.borderDate))}</td>
          <td style="${tdOpen()}">${esc(r.transporter ?? "—")}</td>
          <td style="${tdOpen()}">${esc(r.location ?? "—")}</td>
          <td style="${tdOpen("right", true)}">${esc("$" + fmt(r.dutyFee, 0))}</td>
          <td style="${tdOpen("right", false, "#9ca3af")}">—</td>
          <td style="${tdOpen("right", true)}">${esc("$" + fmt(r.dutyFee, 0))}</td>
          <td style="${tdOpen("center", false, "#059669")};font-weight:700;">Prepaid</td>
        </tr>`;
      });
      waVisibleOpenPartial.forEach((r, i) => {
        const isPartial = r.allocationStatus === "Partially Cleared";
        const bg = isPartial ? "#fffbeb" : i % 2 === 0 ? "#ffffff" : "#f9fafb";
        const statusColor = isPartial ? "#b45309" : "#374151";
        const statusLabel = isPartial ? "Partial" : "Open";
        openRowsHtml += `<tr style="background:${bg}">
          <td style="${tdOpen("left", true)}">${esc(r.containerNumber)}</td>
          <td style="${tdOpen()}">${esc(r.supplierCode ?? "—")}</td>
          <td style="${tdOpen()}">${esc(r.numberPlate ?? "—")}</td>
          <td style="${tdOpen()}">${esc(fmtD(r.offloadDate ?? null))}</td>
          <td style="${tdOpen()}">${esc(fmtD(r.borderDate))}</td>
          <td style="${tdOpen()}">${esc(r.transporter ?? "—")}</td>
          <td style="${tdOpen()}">${esc(r.location ?? "—")}</td>
          <td style="${tdOpen("right", true)}">${esc("$" + fmt(r.dutyFee, 0))}</td>
          <td style="${tdOpen("right", false, r.clearedAmount > 0 ? "#059669" : "#9ca3af")}">${r.clearedAmount > 0 ? esc("$" + fmt(r.clearedAmount, 0)) : "—"}</td>
          <td style="${tdOpen("right", true)}">${esc("$" + fmt(r.remainingAmount, 0))}</td>
          <td style="${tdOpen("center", false, statusColor)};font-weight:600">${esc(statusLabel)}</td>
        </tr>`;
      });
    }

    const adjustmentsHtml = hasAdj
      ? `
      <div style="background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:8px 14px;">
        <div style="font-size:10.5px;font-weight:700;color:#374151;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.05em;">Manual Entries</div>
        <table style="width:100%;border-collapse:collapse;">
          ${adjustments
            .map(
              (a) => `
            <tr>
              <td style="font-size:10.5px;padding:2px 0;color:#374151;">${esc(a.description)}</td>
              <td style="font-size:10.5px;padding:2px 0;text-align:right;font-weight:600;color:${a.type === "debit" ? "#059669" : "#dc2626"};">
                ${a.type === "debit" ? "+" : "-"}$${esc(fmt(a.amount, 0))}
              </td>
              <td style="font-size:10.5px;padding:2px 0 2px 8px;font-weight:600;color:${a.type === "debit" ? "#059669" : "#dc2626"};">
                ${a.type === "debit" ? "Dr" : "Cr"}
              </td>
            </tr>`
            )
            .join("")}
        </table>
      </div>`
      : "";

    const finalBal = hasAdj ? adjustedBal : displayBal;
    const finalLabel = hasAdj ? (adjIsDebit ? "Dr" : "Cr") : "";
    const balRowBg = finalBal > 0 ? "#16a34a" : finalBal < 0 ? "#dc2626" : "#475569";
    const balanceRowHtml = hasBalance
      ? `
      <tr style="background:${balRowBg}">
        <td colspan="9" style="padding:9px 10px;font-size:11px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;border:1px solid rgba(0,0,0,0.15);">Account Balance</td>
        <td style="padding:9px 10px;font-size:14px;font-weight:800;color:#ffffff;text-align:right;border:1px solid rgba(0,0,0,0.15);">
          $${esc(fmt(Math.abs(finalBal), 0))}
          ${finalLabel ? `<span style="font-size:11px;opacity:0.85;margin-left:4px;">(${esc(finalLabel)})</span>` : ""}
        </td>
        <td style="padding:9px 10px;border:1px solid rgba(0,0,0,0.15);"></td>
      </tr>`
      : "";

    let transitHtml = "";
    const waTransitRows = transitTransporterFilter
      ? waRemainingRows.filter((r) => r.transporter === transitTransporterFilter)
      : waRemainingRows;
    if (waTransitRows.length > 0) {
      const transitTotal = waTransitRows.reduce((s: number, r) => s + r.dutyFee, 0);
      let transitRowsHtml = "";
      const sortedWaTransitRows = [...waTransitRows].sort((a, b) => {
        const tA = (a.transporter ?? "").toLowerCase(),
          tB = (b.transporter ?? "").toLowerCase();
        if (tA !== tB) return tA < tB ? -1 : 1;
        const sA = (a.supplierCode ?? a.supplierName ?? "").toLowerCase();
        const sB = (b.supplierCode ?? b.supplierName ?? "").toLowerCase();
        return sA < sB ? -1 : sA > sB ? 1 : 0;
      });
      sortedWaTransitRows.forEach((r, i: number) => {
        const bg = i % 2 === 0 ? "#f0f9ff" : "#e0f2fe";
        transitRowsHtml += `<tr style="background:${bg}">
          <td style="${tdTransit("left", true)}">${esc(r.containerNumber)}</td>
          <td style="${tdTransit()}">${esc(r.supplierCode ?? r.supplierName ?? "—")}</td>
          <td style="${tdTransit()}">${esc(r.numberPlate ?? "—")}</td>
          <td style="${tdTransit()}">${esc(fmtD(r.borderDate))}</td>
          <td style="${tdTransit()}">${esc(r.transporter ?? "—")}</td>
          <td style="${tdTransit()}">${esc(r.location ?? "—")}</td>
          <td style="${tdTransit("right", true)}">${esc("$" + fmt(r.dutyFee, 0))}</td>
        </tr>`;
      });
      const transitCols = ["CONTAINER", "SUPPLIER", "PLATE", "BORDER DATE", "TRANSPORTER", "LOCATION", "DUTY"];
      transitHtml = `
        <div style="background:#1e293b;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;margin-top:2px;">
          <span style="font-size:12px;font-weight:700;color:#f8fafc;text-transform:uppercase;letter-spacing:0.08em;">
            In Transit — ${waTransitRows.length} Container${waTransitRows.length !== 1 ? "s" : ""}${waPrepaidRows.length > 0 ? ` (${waPrepaidRows.length} Prepaid)` : ""}
          </span>
          <span style="font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.04em;">$${fmt(transitTotal, 0)} Upcoming Duty</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>${transitCols.map((h) => `<th style="${thTransit()}">${h}</th>`).join("")}</tr></thead>
          <tbody>${transitRowsHtml}</tbody>
        </table>`;
    }

    const W = 1060;
    const capture = document.createElement("div");
    capture.style.cssText =
      `position:fixed;top:-9999px;left:-9999px;width:${W}px;` +
      "background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;" +
      "border:1px solid #d1d5db;border-radius:6px;overflow:hidden;";
    const openCols = [
      "CONTAINER",
      "SUPPLIER",
      "PLATE",
      "OFFLOAD DATE",
      "BORDER DATE",
      "TRANSPORTER",
      "LOCATION",
      "DUTY",
      "CLEARED",
      "REMAINING",
      "STATUS",
    ];

    capture.innerHTML = `
      <div style="background:#1e293b;padding:18px 16px;display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:22px;font-weight:800;color:#f8fafc;letter-spacing:0.08em;text-transform:uppercase;">${esc(agentName)}</div>
        <div style="font-size:11px;color:#94a3b8;font-weight:500;">Agent Duty Summary &nbsp;·&nbsp; ${today}</div>
      </div>
      ${adjustmentsHtml}
      <table style="width:100%;border-collapse:collapse;table-layout:auto;">
        <thead><tr>${openCols.map((h) => `<th style="${thOpen()}">${h}</th>`).join("")}</tr></thead>
        <tbody>${openRowsHtml}${balanceRowHtml}</tbody>
      </table>
      ${transitHtml}
      <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:5px 12px;font-size:10px;color:#9ca3af;text-align:right;">
        HMD International Group &nbsp;·&nbsp; ERP System &nbsp;·&nbsp; ${new Date().toLocaleString("en-GB")}
      </div>`;

    document.body.appendChild(capture);
    const canvas = await html2canvas(capture, {
      // 2x is still crisp on WhatsApp but is much faster and far smaller than
      // the old 3x PNG path, especially for agents with dozens of containers.
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#ffffff",
      logging: false,
      width: W,
      height: capture.scrollHeight,
      windowWidth: W,
      windowHeight: capture.scrollHeight,
    });
    document.body.removeChild(capture);

    const imageBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error());
        },
        "image/jpeg",
        0.86
      );
    });
    const todayStr = new Date().toISOString().substring(0, 10);
    const fileName = `AgentDuty_${agent.agentName}_${todayStr}.jpg`;
    const formData = new FormData();
    formData.append("image", imageBlob, fileName);
    formData.append("agentName", agent.agentName);
    formData.append("fileName", fileName);

    const response = await fetch("/api/git/send-agent-duty-whatsapp", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const responseBody = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(responseBody.message || response.statusText);

    toast({ title: "Sent", description: `Balance allocation sent to ${agent.agentName} WhatsApp group.` });
  } catch (err) {
    toast({ title: "Failed to send", description: getErrorDetails(err).message, variant: "destructive" });
  } finally {
    setWaSending(false);
  }
}
