import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmt, useSpReportsState } from "./useSpReportsState";
import { SpReportsTabsSection } from "./SpReportsTabsSection";

export default function SpReports() {
  const {
    accounts,
    completeMonth,
    correctedProfit,
    correctionConfirmation,
    correctionReason,
    developerCorrection,
    editProfitOpen,
    endDate,
    exportCashAccountId,
    exportFrom,
    exportLocationId,
    exportTo,
    exporting,
    exportingV2,
    handleExportSalesForm,
    handleExportSalesFormV2,
    isDeveloper,
    locations,
    profit,
    profitLoading,
    recordChanges,
    saveProfitCorrection,
    selectedCompany,
    selectedMonth,
    setCorrectedProfit,
    setCorrectionConfirmation,
    setCorrectionReason,
    setEditProfitOpen,
    setEndDate,
    setExportCashAccountId,
    setExportFrom,
    setExportLocationId,
    setExportTo,
    setStartDate,
    setTab,
    splits,
    splitsLoading,
    startDate,
    tab,
  } = useSpReportsState();

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Profit & Loss and Sales Form export</p>
      </div>

      <SpReportsTabsSection
        accounts={accounts}
        completeMonth={completeMonth}
        developerCorrection={developerCorrection}
        endDate={endDate}
        exportCashAccountId={exportCashAccountId}
        exportFrom={exportFrom}
        exportLocationId={exportLocationId}
        exportTo={exportTo}
        exporting={exporting}
        exportingV2={exportingV2}
        handleExportSalesForm={handleExportSalesForm}
        handleExportSalesFormV2={handleExportSalesFormV2}
        isDeveloper={isDeveloper}
        locations={locations}
        profit={profit}
        profitLoading={profitLoading}
        recordChanges={recordChanges}
        selectedCompany={selectedCompany}
        setCorrectedProfit={setCorrectedProfit}
        setCorrectionConfirmation={setCorrectionConfirmation}
        setCorrectionReason={setCorrectionReason}
        setEditProfitOpen={setEditProfitOpen}
        setEndDate={setEndDate}
        setExportCashAccountId={setExportCashAccountId}
        setExportFrom={setExportFrom}
        setExportLocationId={setExportLocationId}
        setExportTo={setExportTo}
        setStartDate={setStartDate}
        setTab={setTab}
        splits={splits}
        splitsLoading={splitsLoading}
        startDate={startDate}
        tab={tab}
      />
      {isDeveloper && (
        <Dialog open={editProfitOpen} onOpenChange={setEditProfitOpen}>
          <DialogContent data-testid="dialog-sp-developer-profit-correction">
            <DialogHeader>
              <DialogTitle>Correct Net Profit — {selectedMonth}</DialogTitle>
              <DialogDescription>
                Developer only. Set the final monthly profit; the original POS sales stay unchanged. The closing Journal
                will include a balanced correction.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="text-sm">Original profit: {fmt(developerCorrection?.sourceNetProfit)}</div>
              <label className="block text-sm font-medium" htmlFor="sp-correct-net-profit">
                Correct final profit (USD)
              </label>
              <Input
                id="sp-correct-net-profit"
                type="number"
                step="0.01"
                value={correctedProfit}
                onChange={(event) => setCorrectedProfit(event.target.value)}
                data-testid="input-sp-correct-profit"
              />
              <label className="block text-sm font-medium" htmlFor="sp-correct-profit-reason">
                Reason (developer audit only)
              </label>
              <Input
                id="sp-correct-profit-reason"
                value={correctionReason}
                maxLength={500}
                onChange={(event) => setCorrectionReason(event.target.value)}
                data-testid="input-sp-profit-correction-reason"
              />
              <p className="text-xs text-muted-foreground">
                Any difference posts to a suspense ledger at the monthly close and must be reconciled later.
              </p>
              <label className="block text-sm font-medium" htmlFor="sp-correct-profit-confirm">
                Type ADJUST SP PROFIT
              </label>
              <Input
                id="sp-correct-profit-confirm"
                value={correctionConfirmation}
                onChange={(event) => setCorrectionConfirmation(event.target.value)}
              />
              {developerCorrection?.correction && (
                <div className="text-xs text-muted-foreground" data-testid="sp-profit-correction-audit">
                  Previous correction: {developerCorrection.correction.reason}
                  {" — "}
                  {developerCorrection.correction.actorName || "Developer"}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditProfitOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  saveProfitCorrection.isPending ||
                  correctionReason.trim().length < 5 ||
                  correctionConfirmation !== "ADJUST SP PROFIT" ||
                  !/^-?[0-9]+(?:[.][0-9]{1,2})?$/.test(correctedProfit)
                }
                onClick={() => saveProfitCorrection.mutate()}
                data-testid="button-sp-save-correct-profit"
              >
                {saveProfitCorrection.isPending ? "Saving..." : "Save Corrected Profit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
