import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody } from "@/components/ui/table";
import type { Container } from "@shared/schema";
import { OtwContainerFilters } from "./otw/OtwContainerFilters";
import { OtwContainerTableHeader } from "./otw/OtwContainerTableHeader";
import { OtwContainerRow } from "./otw/OtwContainerRow";
import { OtwEmptyState } from "./otw/OtwEmptyState";

interface OtwContainersTableProps {
  filteredOtwContainers: Container[];
  otwContainers: Container[];
  otwSearchTerm: string;
  setOtwSearchTerm: (v: string) => void;
  otwSupplierFilter: string[];
  setOtwSupplierFilter: React.Dispatch<React.SetStateAction<string[]>>;
  otwLocationFilter: string;
  setOtwLocationFilter: (v: string) => void;
  otwTruckFilter: string;
  setOtwTruckFilter: (v: string) => void;
  otwAgentFilter: string;
  setOtwAgentFilter: (v: string) => void;
  otwTransporterFilter: string;
  setOtwTransporterFilter: (v: string) => void;
  otwDocReceivedFilter: string;
  setOtwDocReceivedFilter: (v: string) => void;
  otwFreightStatusFilter: string;
  setOtwFreightStatusFilter: (v: string) => void;
  otwNotesFilter: string;
  setOtwNotesFilter: (v: string) => void;
  uniqueOtwLocations: string[];
  uniqueOtwSuppliers: number[];
  uniqueOtwAgents: string[];
  uniqueOtwTransporters: string[];
  uniqueOtwTrucks: string[];
  getSupplierName: (id: number) => string;
  formatAmount: (n: number) => string;
  freightStatusMap: Record<number, { totalFreight: number; totalPaid: number; status: string }>;
  getEditValue: (container: Container, field: keyof Container) => unknown;
  setEditValue: (id: number, field: keyof Container, value: unknown) => Promise<void>;
  hasChanges: (id: number) => boolean;
  saveTracking: (id: number) => Promise<void>;
  savingIds: Set<number>;
  handleKeyDown: (e: React.KeyboardEvent, id: number, fieldIdx: number) => void;
  autoSizeStyle: (value: unknown, placeholder?: string, minCh?: number, maxCh?: number) => React.CSSProperties;
}

export function OtwContainersTable({
  filteredOtwContainers,
  otwContainers,
  otwSearchTerm,
  setOtwSearchTerm,
  otwSupplierFilter,
  setOtwSupplierFilter,
  otwLocationFilter,
  setOtwLocationFilter,
  otwTruckFilter,
  setOtwTruckFilter,
  otwAgentFilter,
  setOtwAgentFilter,
  otwTransporterFilter,
  setOtwTransporterFilter,
  otwDocReceivedFilter,
  setOtwDocReceivedFilter,
  otwFreightStatusFilter,
  setOtwFreightStatusFilter,
  otwNotesFilter,
  setOtwNotesFilter,
  uniqueOtwLocations,
  uniqueOtwSuppliers,
  uniqueOtwAgents,
  uniqueOtwTransporters,
  uniqueOtwTrucks,
  getSupplierName,
  formatAmount,
  freightStatusMap,
  getEditValue,
  setEditValue,
  hasChanges,
  saveTracking,
  savingIds,
  handleKeyDown,
  autoSizeStyle,
}: OtwContainersTableProps) {
  return (
    <div className="space-y-4">
      <OtwContainerFilters
        otwSearchTerm={otwSearchTerm}
        setOtwSearchTerm={setOtwSearchTerm}
        otwSupplierFilter={otwSupplierFilter}
        setOtwSupplierFilter={setOtwSupplierFilter}
        otwLocationFilter={otwLocationFilter}
        setOtwLocationFilter={setOtwLocationFilter}
        otwTruckFilter={otwTruckFilter}
        setOtwTruckFilter={setOtwTruckFilter}
        otwAgentFilter={otwAgentFilter}
        setOtwAgentFilter={setOtwAgentFilter}
        otwTransporterFilter={otwTransporterFilter}
        setOtwTransporterFilter={setOtwTransporterFilter}
        otwDocReceivedFilter={otwDocReceivedFilter}
        setOtwDocReceivedFilter={setOtwDocReceivedFilter}
        otwFreightStatusFilter={otwFreightStatusFilter}
        setOtwFreightStatusFilter={setOtwFreightStatusFilter}
        otwNotesFilter={otwNotesFilter}
        setOtwNotesFilter={setOtwNotesFilter}
        uniqueOtwLocations={uniqueOtwLocations}
        uniqueOtwSuppliers={uniqueOtwSuppliers}
        uniqueOtwAgents={uniqueOtwAgents}
        uniqueOtwTransporters={uniqueOtwTransporters}
        uniqueOtwTrucks={uniqueOtwTrucks}
        getSupplierName={getSupplierName}
      />

      {filteredOtwContainers.length === 0 ? (
        <OtwEmptyState otwContainers={otwContainers} />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <OtwContainerTableHeader />
              <TableBody>
                {filteredOtwContainers.map((container) => (
                  <OtwContainerRow
                    key={container.id}
                    container={container}
                    getSupplierName={getSupplierName}
                    formatAmount={formatAmount}
                    freightStatusMap={freightStatusMap}
                    getEditValue={getEditValue}
                    setEditValue={setEditValue}
                    hasChanges={hasChanges}
                    saveTracking={saveTracking}
                    savingIds={savingIds}
                    handleKeyDown={handleKeyDown}
                    autoSizeStyle={autoSizeStyle}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
