import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DailyExportTab } from "../../client/src/pages/settings/DailyExportTab";

function renderTab(canSendWa: boolean) {
  return render(
    <DailyExportTab
      backupFetching={false}
      refetchBackup={vi.fn()}
      companies={[]}
      fromDate=""
      setFromDate={vi.fn()}
      toDate=""
      setToDate={vi.fn()}
      startExport={vi.fn()}
      recipients={[]}
      waReady
      sendingWa={false}
      sendViaWhatsApp={vi.fn()}
      canSendWa={canSendWa}
      showCompanies={false}
      setShowCompanies={vi.fn()}
      showHistory={false}
      setShowHistory={vi.fn()}
      historyFilter="all"
      setHistoryFilter={vi.fn()}
      filteredRuns={[]}
    />
  );
}

describe("Daily export WhatsApp button visibility", () => {
  it("hides the all-company WhatsApp export from roles the server rejects", () => {
    renderTab(false);
    expect(screen.queryByTestId("menu-export-whatsapp")).toBeNull();
    expect(screen.getByTestId("button-export-now")).toBeTruthy();
  });

  it("shows it to Admin / Owner / Developer", () => {
    renderTab(true);
    expect(screen.getByTestId("menu-export-whatsapp")).toBeTruthy();
  });
});
