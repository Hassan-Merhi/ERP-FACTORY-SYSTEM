import { CalendarDays } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductionTargetDefaultsDialog } from "./productiontargets/ProductionTargetDefaultsDialog";
import { ProductionTargetsEditorDialog } from "./productiontargets/ProductionTargetsEditorDialog";
import { ProductionExcelRangeDialog } from "./productiontargets/ProductionExcelRangeDialog";
import { ProductionTargetsDateRangeDialog } from "./productiontargets/ProductionTargetsDateRangeDialog";
import "./productiontargets/productionTargetsPremium.css";
import { ProductionTargetKpiGrid } from "./productiontargets/ProductionTargetKpiGrid";
import { ProductionBonusesLauncher } from "./productiontargets/ProductionBonusesLauncher";
import { ProductionTargetNotices } from "./productiontargets/ProductionTargetNotices";
import { useFactoryProductionTargetsState } from "./useFactoryProductionTargetsState";
import { FactoryProductionTargetsSection } from "./FactoryProductionTargetsSection";
import { FactoryProductionTargetsSection2 } from "./FactoryProductionTargetsSection2";
import { FactoryProductionTargetsContent } from "./FactoryProductionTargetsContent";

export default function FactoryProductionTargets() {
  const {
    busy,
    canManageBonuses,
    categoryFilter,
    categoryOptions,
    collapsedGroups,
    customRange,
    dateRangeOpen,
    defaultsEditorOpen,
    editorOpen,
    endProductionMutation,
    excelRangeOpen,
    exportWeeklyMutation,
    finalized,
    groupedVisibleRows,
    isLoading,
    missingTargetDays,
    navigate,
    period,
    periodType,
    productionReportGroups,
    productionReportRef,
    referenceDate,
    rows,
    search,
    sendWhatsappMutation,
    setCategoryFilter,
    setCollapsedGroups,
    setCustomRange,
    setDateRangeOpen,
    setDefaultsEditorOpen,
    setEditorOpen,
    setExcelRangeOpen,
    setPeriodType,
    setReferenceDate,
    setSearch,
    setStatusFilter,
    statusFilter,
    totals,
    tr,
    workerTotals,
  } = useFactoryProductionTargetsState();

  return (
    <div className="production-targets-modern space-y-4">
      <FactoryProductionTargetsContent
        busy={busy}
        customRange={customRange}
        endProductionMutation={endProductionMutation}
        exportWeeklyMutation={exportWeeklyMutation}
        finalized={finalized}
        period={period}
        periodType={periodType}
        referenceDate={referenceDate}
        rows={rows}
        sendWhatsappMutation={sendWhatsappMutation}
        setCustomRange={setCustomRange}
        setDateRangeOpen={setDateRangeOpen}
        setDefaultsEditorOpen={setDefaultsEditorOpen}
        setEditorOpen={setEditorOpen}
        setExcelRangeOpen={setExcelRangeOpen}
        setPeriodType={setPeriodType}
        setReferenceDate={setReferenceDate}
        tr={tr}
      />

      <div className="pt-note">
        <CalendarDays className="mr-1.5 inline h-3.5 w-3.5" />
        {period.start}
        {period.end !== period.start ? ` — ${period.end}` : ""}
        <span className="ml-3">
          {periodType === "daily"
            ? tr("useEditorToManageTargets")
            : "Targets and attendance are summed from each date in this period; edit individual days in Daily view."}
        </span>
      </div>

      <ProductionTargetNotices
        tr={tr}
        showMissingTargets={periodType !== "daily" && missingTargetDays > 0 && !isLoading}
        missingTargetDays={missingTargetDays}
        finalized={Boolean(finalized)}
      />

      <ProductionTargetKpiGrid
        tr={tr}
        totals={totals}
        workerTotals={workerTotals}
        missingTargetDays={missingTargetDays}
      />

      {periodType === "daily" && canManageBonuses && (
        <ProductionBonusesLauncher onOpen={() => navigate("/factory/production-bonuses?date=" + referenceDate)} />
      )}

      <div className="pt-filters">
        <div className="pt-filter-search relative">
          <SearchField
            value={search}
            onValueChange={setSearch}
            placeholder={tr("searchPlaceholder")}
            aria-label={tr("searchPlaceholder")}
            showClear={false}
            clearOnEscape={false}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger
              className="w-[180px]"
              aria-label="Filter category"
              data-testid="select-production-category-filter"
            >
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categoryOptions.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger
              className="w-[160px]"
              aria-label="Filter attendance"
              data-testid="select-production-attendance-filter"
            >
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="present">{tr("present")}</SelectItem>
              <SelectItem value="absent">{tr("absent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <FactoryProductionTargetsSection
        collapsedGroups={collapsedGroups}
        groupedVisibleRows={groupedVisibleRows}
        isLoading={isLoading}
        periodType={periodType}
        setCollapsedGroups={setCollapsedGroups}
        tr={tr}
      />

      {periodType !== "daily" && (
        <ProductionTargetsDateRangeDialog
          open={dateRangeOpen}
          onOpenChange={setDateRangeOpen}
          range={period}
          onApply={(nextRange) => {
            setCustomRange(nextRange);
            setDateRangeOpen(false);
          }}
        />
      )}

      <ProductionExcelRangeDialog
        open={excelRangeOpen}
        onOpenChange={setExcelRangeOpen}
        exporting={exportWeeklyMutation.isPending}
        onExport={(dates) => exportWeeklyMutation.mutate(dates)}
      />

      <ProductionTargetDefaultsDialog
        open={defaultsEditorOpen}
        onOpenChange={setDefaultsEditorOpen}
        rows={rows}
        effectiveFrom={referenceDate}
      />

      <ProductionTargetsEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rows={rows}
        periodType={periodType}
        periodStart={period.start}
        periodEnd={period.end}
        finalized={finalized}
      />

      <FactoryProductionTargetsSection2
        productionReportGroups={productionReportGroups}
        productionReportRef={productionReportRef}
        referenceDate={referenceDate}
        rows={rows}
        totals={totals}
        tr={tr}
      />
    </div>
  );
}
