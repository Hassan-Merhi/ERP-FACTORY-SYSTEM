import { searchAny } from "@shared/searchNormalization";
import { useMemo } from "react";
import { EnrichedContainerRow, EtaFilterValue } from "./gitContainerTypes";

interface UseContainerFiltersProps {
  allContainers: EnrichedContainerRow[];
  companyFilter: string;
  containerFilters: string[];
  supplierFilters: string[];
  transporterFilters: string[];
  agentFilters: string[];
  truckFilters: string[];
  locationFilters: string[];
  docsFilter: string;
  delayedFilter: string;
  freightFilter: string;
  etaFilter: EtaFilterValue;
  notesFilter: string;
  search: string;
  sortOrder: string;
}

export function useContainerFilters({
  allContainers,
  companyFilter,
  containerFilters,
  supplierFilters,
  transporterFilters,
  agentFilters,
  truckFilters,
  locationFilters,
  docsFilter,
  delayedFilter,
  freightFilter,
  etaFilter,
  notesFilter,
  search,
  sortOrder,
}: UseContainerFiltersProps) {
  return useMemo(() => {
    return allContainers
      .filter((c) => {
        if (companyFilter !== "ALL" && c.companyName !== companyFilter) return false;
        if (containerFilters.length > 0 && !containerFilters.includes(c.containerNumber)) return false;
        if (supplierFilters.length > 0 && !supplierFilters.includes(c.supplierCode ?? "")) return false;
        if (transporterFilters.length > 0) {
          const tr = (c.transporter ?? "").trim();
          const match = transporterFilters.some((f) => {
            if (f === "NO_TRANSPORTER") return !tr;
            return tr === f;
          });
          if (!match) return false;
        }
        if (agentFilters.length > 0) {
          const ag = (c.agent ?? "").trim();
          const match = agentFilters.some((f) => {
            if (f === "NO_AGENT") return !ag;
            return ag === f;
          });
          if (!match) return false;
        }
        if (truckFilters.length > 0) {
          const plate = (c.numberPlate ?? "").trim();
          const match = truckFilters.some((f) => {
            if (f === "HAS_TRUCK") return !!plate;
            if (f === "NO_TRUCK") return !plate;
            return plate === f;
          });
          if (!match) return false;
        }
        if (locationFilters.length > 0) {
          const loc = (c.trackingLocation ?? "").trim();
          const match = locationFilters.some((f) => {
            if (f === "HAS_LOCATION") return !!loc;
            if (f === "NO_LOCATION") return !loc;
            return loc === f;
          });
          if (!match) return false;
        }
        if (docsFilter === "MISSING" && c.docReceived) return false;
        if (docsFilter === "RECEIVED" && !c.docReceived) return false;
        if (delayedFilter === "YES" && !(c.daysDelayed && c.daysDelayed > 0)) return false;
        if (delayedFilter === "OVERDUE" && !c.isOverdue) return false;
        if (delayedFilter === "NO" && (c.daysDelayed && c.daysDelayed > 0)) return false;
        if (freightFilter === "HAS_FREIGHT" && !(parseFloat(c.poFreight ?? "0") > 0)) return false;
        if (freightFilter === "NO_FREIGHT" && parseFloat(c.poFreight ?? "0") > 0) return false;
        if (etaFilter !== "ALL") {
          const eta = c.eta || null;
          if (!eta) {
            // Container has no ETA date
            if (!etaFilter.includeNoEta) return false;
          } else {
            // Container has an ETA date — check if it's in the selected set
            if (!etaFilter.selectedDates.includes(eta)) return false;
          }
        }
        if (notesFilter === "WITH" && !(c.trackingDescription ?? "").trim()) return false;
        if (notesFilter === "WITHOUT" && !!(c.trackingDescription ?? "").trim()) return false;
        if (search) {
          if (!searchAny(search, c.containerNumber, c.companyName, c.numberPlate, c.transporter, c.agent))
            return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortOrder === "ETA_ASC" || sortOrder === "ETA_DESC") {
          const aMs = a.eta ? new Date(a.eta).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
          const bMs = b.eta ? new Date(b.eta).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
          if (aMs !== bMs) return sortOrder === "ETA_ASC" ? aMs - bMs : bMs - aMs;
        }
        const co = a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" });
        if (co !== 0) return co;
        const sh = (a.shopName ?? "").localeCompare(b.shopName ?? "", undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (sh !== 0) return sh;
        return a.containerNumber.localeCompare(b.containerNumber);
      });
  }, [allContainers, companyFilter, containerFilters, supplierFilters, transporterFilters, agentFilters, truckFilters, locationFilters, docsFilter, delayedFilter, freightFilter, etaFilter, notesFilter, search, sortOrder]);
}
