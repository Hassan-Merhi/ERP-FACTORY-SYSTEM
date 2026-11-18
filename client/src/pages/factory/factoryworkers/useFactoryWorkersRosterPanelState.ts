// Extracted from ./FactoryWorkersRosterPanel.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Banknote, Bus, Download, UserCheck, Users, UserX, WalletCards } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatUsd } from "@/lib/moneyDisplay";
import type { PeopleFilterChip } from "../people/PeopleRoster";
import { exportPeopleTablePdf, type PeopleExportColumn } from "../people/peopleExport";
import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

export const SALARY_RANGE_LABELS: Record<string, string> = {
  "0-500": "Under $500",
  "500-1000": "$500 – under $1,000",
  "1000-2000": "$1,000 – under $2,000",
  "2000-5000": "$2,000 – under $5,000",
  "5000+": "$5,000 and above",
};

export interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
  onOpenCategories?: () => void;
}

export function useFactoryWorkersRosterPanelState({ model, onOpenCategories }: FactoryWorkersModelProps) {
  const { toast } = useToast();
  const {
    setLocation,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    filtersOpen,
    setFiltersOpen,
    positionFilter,
    setPositionFilter,
    locationFilter,
    setLocationFilter,
    nationalityFilter,
    setNationalityFilter,
    salaryTypeFilter,
    setSalaryTypeFilter,
    salaryRangeFilter,
    setSalaryRangeFilter,
    transportFilter,
    setTransportFilter,
    advanceFilter,
    setAdvanceFilter,
    setCreateOpen,
    importLoading,
    fileInputRef,
    workers,
    isLoading,
    docCounts,
    amountDue,
    reactivateMutation,
    canChangeExistingRecords,
    canCreate,
    handleImportFile,
    resetForm,
    openEdit,
    openEndContract,
    uniquePositions,
    uniqueLocations,
    uniqueNationalities,
    uniqueSalaryTypes,
    activeFilterCount,
    clearAllFilters,
    filteredWorkers,
    activeCount,
    inactiveCount,
    handleExportSalaries,
    totalSalary,
    totalTransport,
    totalAdvances,
    totalRemainingToBePaid,
    showCategories,
  } = model;

  const [pdfBusy, setPdfBusy] = useState(false);
  const money = (amount: number) => formatUsd(amount, 0, 2);
  const kpiCards = [
    { label: "Total", value: String(workers?.length ?? 0), icon: Users },
    { label: "Active", value: String(activeCount), icon: UserCheck },
    { label: "Inactive", value: String(inactiveCount), icon: UserX },
    { label: "Total Salary", value: money(totalSalary), icon: Download },
    { label: "Transport", value: money(totalTransport), icon: Bus },
    { label: "Advances", value: money(totalAdvances), icon: Banknote },
    { label: "Total Remaining", value: formatUsd(totalRemainingToBePaid, 2), icon: WalletCards, emphasis: true },
  ];

  type WorkerRow = (typeof filteredWorkers)[number];
  // PDF carries the same columns as the salaries Excel, with the Due Today amounts shown on screen.
  const pdfColumns: PeopleExportColumn<WorkerRow>[] = [
    { header: "#", type: "integer", value: (_worker, index) => index + 1 },
    { header: "Code", value: (worker) => worker.employeeCode ?? "" },
    { header: "Name", value: (worker) => worker.fullName },
    { header: "Position", value: (worker) => worker.position ?? "" },
    { header: "Department", value: (worker) => worker.department ?? "" },
    { header: "Salary Type", value: (worker) => worker.salaryType || "Monthly" },
    { header: "Base Salary", type: "money", value: (worker) => Number(worker.baseSalary || 0) || 0 },
    {
      header: "Due Today",
      type: "money",
      value: (worker) => {
        const net = amountDue[worker.id]?.net;
        return typeof net === "number" && Number.isFinite(net) ? Math.max(0, net) : null;
      },
    },
  ];
  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      const salaryTotal = filteredWorkers.reduce((sum, worker) => sum + (Number(worker.baseSalary || 0) || 0), 0);
      const dueTotal = filteredWorkers.reduce((sum, worker) => {
        const net = amountDue[worker.id]?.net;
        return sum + (typeof net === "number" && net > 0 ? net : 0);
      }, 0);
      await exportPeopleTablePdf({
        title: "Factory Workers — Salaries",
        fileStem: "workers salaries",
        columns: pdfColumns,
        rows: filteredWorkers,
        footer: [null, "", `Total Workers: ${filteredWorkers.length}`, "", "", "TOTAL", salaryTotal, dueTotal],
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const filterChips = [
    positionFilter !== "all" && {
      key: "position",
      label: "Position",
      value: positionFilter,
      onRemove: () => setPositionFilter("all"),
    },
    locationFilter !== "all" && {
      key: "location",
      label: "Location",
      value: locationFilter,
      onRemove: () => setLocationFilter("all"),
    },
    nationalityFilter !== "all" && {
      key: "nationality",
      label: "Nationality",
      value: nationalityFilter,
      onRemove: () => setNationalityFilter("all"),
    },
    salaryTypeFilter !== "all" && {
      key: "salaryType",
      label: "Type",
      value: salaryTypeFilter,
      onRemove: () => setSalaryTypeFilter("all"),
    },
    salaryRangeFilter !== "all" && {
      key: "salaryRange",
      label: "Salary",
      value: SALARY_RANGE_LABELS[salaryRangeFilter] ?? salaryRangeFilter,
      onRemove: () => setSalaryRangeFilter("all"),
    },
    transportFilter !== "all" && {
      key: "transport",
      label: transportFilter === "has" ? "Has transport" : "No transport",
      onRemove: () => setTransportFilter("all"),
    },
    advanceFilter !== "all" && {
      key: "advance",
      label: advanceFilter === "has" ? "Has advance" : "No advance",
      onRemove: () => setAdvanceFilter("all"),
    },
  ].filter((chip): chip is PeopleFilterChip => Boolean(chip));

  return {
    activeFilterCount,
    advanceFilter,
    amountDue,
    canChangeExistingRecords,
    canCreate,
    clearAllFilters,
    docCounts,
    exportPdf,
    fileInputRef,
    filterChips,
    filteredWorkers,
    filtersOpen,
    handleExportSalaries,
    handleImportFile,
    importLoading,
    isLoading,
    kpiCards,
    locationFilter,
    nationalityFilter,
    onOpenCategories,
    openEdit,
    openEndContract,
    pdfBusy,
    positionFilter,
    reactivateMutation,
    resetForm,
    salaryRangeFilter,
    salaryTypeFilter,
    searchQuery,
    setAdvanceFilter,
    setCreateOpen,
    setFiltersOpen,
    setLocation,
    setLocationFilter,
    setNationalityFilter,
    setPositionFilter,
    setSalaryRangeFilter,
    setSalaryTypeFilter,
    setSearchQuery,
    setStatusFilter,
    setTransportFilter,
    showCategories,
    statusFilter,
    toast,
    transportFilter,
    uniqueLocations,
    uniqueNationalities,
    uniquePositions,
    uniqueSalaryTypes,
  };
}
