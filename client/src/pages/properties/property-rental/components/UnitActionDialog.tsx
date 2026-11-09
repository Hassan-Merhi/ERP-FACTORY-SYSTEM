/**
 * UnitActionDialog — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Plus, DollarSign, FileEdit, Send, XCircle, UserCog } from "lucide-react";
import type { CashAccount, Contract, LedgerRow, Payment, Unit } from "../types";
import { useApiBase } from "../shared";
import { useCompany } from "@/contexts/CompanyContext";
import { VacantUnitInfoForm } from "./VacantUnitInfoForm";
import { StartContractForm } from "./StartContractForm";
import { PaymentForm } from "./PaymentForm";
import { ModifyRentForm } from "./ModifyRentForm";
import { GuaranteeForm } from "./GuaranteeForm";
import { EndContractForm } from "./EndContractForm";
import { EditInfoForm } from "./EditInfoForm";
import { LedgerView } from "./LedgerView";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export // ──────────────────────────────────────────────────────────
// UNIT ACTION DIALOG (4 tabs + ledger)
// ──────────────────────────────────────────────────────────
function UnitActionDialog({
  unit,
  cashAccounts,
  onClose,
  unitType,
  testIdPrefix,
}: {
  unit: Unit;
  cashAccounts: CashAccount[];
  onClose: () => void;
  unitType: "WAREHOUSE" | "SHOP";
  testIdPrefix: string;
}) {
  const apiBase = useApiBase();
  const { selectedCompany } = useCompany();
  // View Only and Create Only roles cannot change an existing unit or contract.
  // Create Only may start a contract on a vacant unit but cannot record payments.
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
  const showPaymentTab = !recordChanges.isCreateOnly;
  const contractTabDefault = showPaymentTab ? "payment" : "ledger";
  // Source-module references can read their original contract when the same
  // company is active; a cross-company projection remains read-only.
  const referenceBase =
    unit.sourceModule === "ERP" ? "/api/erp/rental" : unit.sourceModule === "FACTORY" ? "/api/factory/rental" : apiBase;
  const detailApiBase = unit.isInternalLeaseProjection ? referenceBase : apiBase;
  const canReadSourceDetail =
    !unit.isInternalLeaseProjection || (unit.sourceCompanyId === selectedCompany?.id && Boolean(unit.sourceModule));
  const { data: detail, isLoading } = useQuery<{
    unit: Unit;
    contract: Contract | null;
    ledger: LedgerRow[];
    postedPayments: Payment[];
    scheduledPayments: Payment[];
    guaranteePayments: Payment[];
    pastContracts: Contract[];
    isShared?: boolean;
  }>({
    queryKey: [detailApiBase + "/units", unit.id, "detail", selectedCompany?.id],
    enabled: canReadSourceDetail,
    queryFn: async () => {
      const res = await fetch(`${detailApiBase}/units/${unit.id}/detail`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load unit detail");
      return res.json();
    },
  });

  const contract = detail?.contract ?? unit.contract;
  const isShared = unit.isShared || detail?.isShared;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid={`dialog-${testIdPrefix}-actions`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{unit.unitNumber}</Badge>
            {contract && <span className="text-base font-normal text-muted-foreground">— {contract.tenantName}</span>}
            {!contract && <Badge variant="secondary">Vacant</Badge>}
            {unit.isInternalLeaseProjection ? (
              <Badge className="bg-violet-600 text-white text-xs">
                Internal {unit.sourceModule === "ERP" ? "ERP" : "Factory"} lease · read only
              </Badge>
            ) : isShared ? (
              <Badge className="bg-sky-600 text-white text-xs">
                Shared from {unit.ownerCompanyName ?? "another company"}
              </Badge>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground">Loading…</div>
        ) : !contract ? (
          isShared ? (
            <div className="p-6 text-center text-muted-foreground text-sm">This is a read-only shared unit.</div>
          ) : (
            <Tabs defaultValue="contract" className="w-full">
              <div className="erp-mobile-scroll-tabs pb-1">
                <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Rental unit actions">
                  <TabsTrigger
                    value="info"
                    disabled={!recordChanges.allowed}
                    title={recordChangeReason}
                    data-testid={`tab-${testIdPrefix}-unit-info`}
                  >
                    <UserCog className="h-4 w-4 mr-1" />
                    Edit Info
                  </TabsTrigger>
                  <TabsTrigger value="contract" data-testid={`tab-${testIdPrefix}-new-contract`}>
                    <Plus className="h-4 w-4 mr-1" />
                    New Contract
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="info">
                <VacantUnitInfoForm unit={unit} testIdPrefix={testIdPrefix} />
              </TabsContent>
              <TabsContent value="contract">
                <StartContractForm unitId={unit.id} testIdPrefix={testIdPrefix} onClose={onClose} unitType={unitType} />
              </TabsContent>
            </Tabs>
          )
        ) : unit.isInternalLeaseProjection ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Reference-only {unit.sourceModule === "ERP" ? "ERP" : "Factory"} lease. Manage rent, payments and
              accounting from {unit.sourceModule === "ERP" ? "ERP" : "Factory"} Rentals.
            </p>
            <LedgerView
              ledger={detail?.ledger ?? []}
              postedPayments={detail?.postedPayments ?? []}
              scheduledPayments={detail?.scheduledPayments ?? []}
              guaranteePayments={detail?.guaranteePayments ?? []}
              contract={contract}
              unitId={unit.id}
              readOnly
            />
          </div>
        ) : isShared ? (
          <Tabs defaultValue={contractTabDefault} className="w-full">
            <div className="erp-mobile-scroll-tabs pb-1">
              <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Rental unit actions">
                {showPaymentTab && (
                  <TabsTrigger value="payment" data-testid={`tab-${testIdPrefix}-payment`}>
                    <DollarSign className="h-4 w-4 mr-1" />
                    Payment
                  </TabsTrigger>
                )}
                <TabsTrigger value="ledger" data-testid={`tab-${testIdPrefix}-ledger`}>
                  Statement
                </TabsTrigger>
              </TabsList>
            </div>
            {showPaymentTab && (
              <TabsContent value="payment">
                <PaymentForm
                  contract={contract}
                  cashAccounts={cashAccounts}
                  testIdPrefix={testIdPrefix}
                  unitId={unit.id}
                  ledger={detail?.ledger}
                />
              </TabsContent>
            )}
            <TabsContent value="ledger">
              <LedgerView
                ledger={detail?.ledger ?? []}
                postedPayments={detail?.postedPayments ?? []}
                scheduledPayments={detail?.scheduledPayments ?? []}
                guaranteePayments={detail?.guaranteePayments ?? []}
                contract={contract}
                unitId={unit.id}
                readOnly
              />
            </TabsContent>
          </Tabs>
        ) : (
          <Tabs defaultValue={contractTabDefault} className="w-full">
            <div className="erp-mobile-scroll-tabs pb-1">
              <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Rental unit actions">
                {showPaymentTab && (
                  <TabsTrigger value="payment" data-testid={`tab-${testIdPrefix}-payment`}>
                    <DollarSign className="h-4 w-4 mr-1" />
                    Payment
                  </TabsTrigger>
                )}
                <TabsTrigger value="ledger" data-testid={`tab-${testIdPrefix}-ledger`}>
                  Statement
                </TabsTrigger>
                <TabsTrigger
                  value="edit"
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  data-testid={`tab-${testIdPrefix}-edit`}
                >
                  <UserCog className="h-4 w-4 mr-1" />
                  Edit Info
                </TabsTrigger>
                <TabsTrigger
                  value="modify"
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  data-testid={`tab-${testIdPrefix}-modify`}
                >
                  <FileEdit className="h-4 w-4 mr-1" />
                  Modify Rent
                </TabsTrigger>
                <TabsTrigger
                  value="guarantee"
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  data-testid={`tab-${testIdPrefix}-guarantee`}
                >
                  <Send className="h-4 w-4 mr-1" />
                  Guarantee
                </TabsTrigger>
                <TabsTrigger
                  value="end"
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  data-testid={`tab-${testIdPrefix}-end`}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  End Contract
                </TabsTrigger>
              </TabsList>
            </div>
            {showPaymentTab && (
              <TabsContent value="payment">
                <PaymentForm
                  contract={contract}
                  cashAccounts={cashAccounts}
                  testIdPrefix={testIdPrefix}
                  unitId={unit.id}
                  ledger={detail?.ledger}
                />
              </TabsContent>
            )}
            <TabsContent value="ledger">
              <LedgerView
                ledger={detail?.ledger ?? []}
                postedPayments={detail?.postedPayments ?? []}
                scheduledPayments={detail?.scheduledPayments ?? []}
                guaranteePayments={detail?.guaranteePayments ?? []}
                contract={contract}
                unitId={unit.id}
                readOnly={!recordChanges.allowed}
                onNoteUpdated={() =>
                  queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unit.id, "detail"] })
                }
              />
            </TabsContent>
            <TabsContent value="edit">
              <EditInfoForm
                contract={contract}
                testIdPrefix={testIdPrefix}
                unitId={unit.id}
                unit={unit}
                unitType={unitType}
              />
            </TabsContent>
            <TabsContent value="modify">
              <ModifyRentForm contract={contract} testIdPrefix={testIdPrefix} unitId={unit.id} />
            </TabsContent>
            <TabsContent value="guarantee">
              <GuaranteeForm
                contract={contract}
                cashAccounts={cashAccounts}
                testIdPrefix={testIdPrefix}
                unitId={unit.id}
                payments={detail?.postedPayments ?? []}
              />
            </TabsContent>
            <TabsContent value="end">
              <EndContractForm
                contract={contract}
                cashAccounts={cashAccounts}
                testIdPrefix={testIdPrefix}
                onClose={onClose}
                unitId={unit.id}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────
// START CONTRACT (vacant unit)
// ──────────────────────────────────────────────────────────
