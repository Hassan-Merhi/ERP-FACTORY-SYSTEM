import { useState } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import type { Container } from "@shared/schema";
import type { SoldContainer } from "./types";

export function useContainerFilters(allContainers: Container[], soldContainers: SoldContainer[]) {
  const [searchTerm, setSearchTerm] = useState("");
  const [soldSearchTerm, setSoldSearchTerm] = useState("");
  const [otwSearchTerm, setOtwSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const debouncedSoldSearch = useDebounce(soldSearchTerm, 300);
  const debouncedOtwSearch = useDebounce(otwSearchTerm, 300);
  const [statusFilter, setStatusFilter] = useState("OTW");
  const [supplierFilter, setSupplierFilter] = useState<string[]>([]);
  // OTW Tracking filters
  const [otwLocationFilter, setOtwLocationFilter] = useState("ALL");
  const [otwSupplierFilter, setOtwSupplierFilter] = useState<string[]>([]);
  const [otwAgentFilter, setOtwAgentFilter] = useState("ALL");
  const [otwTransporterFilter, setOtwTransporterFilter] = useState("ALL");
  const [otwTruckFilter, setOtwTruckFilter] = useState("ALL");
  const [otwDocReceivedFilter, setOtwDocReceivedFilter] = useState("ALL");
  const [otwFreightStatusFilter, setOtwFreightStatusFilter] = useState("ALL");
  const [otwNotesFilter, setOtwNotesFilter] = useState("ALL");

  const clearFilters = async () => {
    setStatusFilter("OTW");
    setSupplierFilter("ALL" as unknown as string[]);
    setSearchTerm("");
  };

  const otwContainers = allContainers.filter((c) => c.status === "OTW");

  // Extract unique values for OTW filters
  const uniqueOtwLocations = Array.from(
    new Set(otwContainers.map((c) => c.trackingLocation).filter(Boolean) as string[])
  ).sort();
  const uniqueOtwAgents = Array.from(new Set(otwContainers.map((c) => c.agent).filter(Boolean) as string[])).sort();
  const uniqueOtwTransporters = Array.from(
    new Set(otwContainers.map((c) => c.transporter).filter(Boolean) as string[])
  ).sort();
  const uniqueOtwSuppliers = Array.from(new Set(otwContainers.map((c) => c.supplierId))).sort((a, b) => a - b);
  const uniqueOtwTrucks = Array.from(
    new Set(otwContainers.map((c) => c.numberPlate).filter(Boolean) as string[])
  ).sort();

  const filteredOtwContainers = otwContainers.filter((c) => {
    // Search filter
    if (debouncedOtwSearch) {
      const search = (debouncedOtwSearch || "").toLowerCase();
      if (!(
        (c.containerNumber || "").toLowerCase().includes(search) ||
        (c.shopName?.toLowerCase() || "").includes(search) ||
        (c.agent?.toLowerCase() || "").includes(search)
      )) {
        return false;
      }
    }
    // Location filter
    if (otwLocationFilter !== "ALL" && (c.trackingLocation || "") !== otwLocationFilter) {
      return false;
    }
    // Supplier filter
    if (otwSupplierFilter.length > 0 && !otwSupplierFilter.includes(c.supplierId.toString())) {
      return false;
    }
    // Agent filter
    if (otwAgentFilter !== "ALL" && (c.agent || "") !== otwAgentFilter) {
      return false;
    }
    // Transporter filter
    if (otwTransporterFilter !== "ALL" && (c.transporter || "") !== otwTransporterFilter) {
      return false;
    }
    // Truck # filter
    if (otwTruckFilter !== "ALL" && (c.numberPlate || "") !== otwTruckFilter) {
      return false;
    }
    // Doc Received filter
    if (otwDocReceivedFilter !== "ALL") {
      const docValue = c.docReceived === true;
      if (otwDocReceivedFilter === "YES" && !docValue) return false;
      if (otwDocReceivedFilter === "NO" && docValue) return false;
    }
    // Freight status filter
    if (otwFreightStatusFilter !== "ALL") {
      const fs = (c.freightStatus || "").trim();
      if (otwFreightStatusFilter === "NONE" && fs !== "") return false;
      if (otwFreightStatusFilter !== "NONE" && fs !== otwFreightStatusFilter) return false;
    }
    // Notes filter
    if (otwNotesFilter !== "ALL") {
      const hasNotes = !!(c.trackingDescription || "").trim();
      if (otwNotesFilter === "WITH" && !hasNotes) return false;
      if (otwNotesFilter === "WITHOUT" && hasNotes) return false;
    }
    return true;
  });

  const filteredSoldContainers = soldContainers.filter((sale) => {
    if (!debouncedSoldSearch) return true;
    const searchLower = (debouncedSoldSearch || "").toLowerCase();
    return (
      (sale.containerNumber || "").toLowerCase().includes(searchLower) ||
      (sale.customerName || "").toLowerCase().includes(searchLower)
    );
  });

  const containers = allContainers.filter((c) => {
    if (debouncedSearch && !(c.containerNumber || "").toLowerCase().includes((debouncedSearch || "").toLowerCase())) {
      return false;
    }
    if (statusFilter !== "ALL" && c.status !== statusFilter) {
      return false;
    }
    if (supplierFilter.length > 0 && !supplierFilter.includes(c.supplierId.toString())) {
      return false;
    }
    return true;
  });

  return {
    // Search terms
    searchTerm,
    setSearchTerm,
    soldSearchTerm,
    setSoldSearchTerm,
    otwSearchTerm,
    setOtwSearchTerm,
    // Active filters
    statusFilter,
    setStatusFilter,
    supplierFilter,
    setSupplierFilter,
    // OTW filters
    otwLocationFilter,
    setOtwLocationFilter,
    otwSupplierFilter,
    setOtwSupplierFilter,
    otwAgentFilter,
    setOtwAgentFilter,
    otwTransporterFilter,
    setOtwTransporterFilter,
    otwTruckFilter,
    setOtwTruckFilter,
    otwDocReceivedFilter,
    setOtwDocReceivedFilter,
    otwFreightStatusFilter,
    setOtwFreightStatusFilter,
    otwNotesFilter,
    setOtwNotesFilter,
    // Unique values for OTW filter dropdowns
    uniqueOtwLocations,
    uniqueOtwAgents,
    uniqueOtwTransporters,
    uniqueOtwSuppliers,
    uniqueOtwTrucks,
    // Computed filtered arrays
    otwContainers,
    filteredOtwContainers,
    filteredSoldContainers,
    containers,
    // Actions
    clearFilters,
  };
}
