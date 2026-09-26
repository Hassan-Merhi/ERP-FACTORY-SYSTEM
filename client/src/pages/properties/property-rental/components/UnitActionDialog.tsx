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
import { VacantUnitInfoForm } from "./VacantUnitInfoForm";
import { StartContractForm } from "./StartContractForm";
import { PaymentForm } from "./PaymentForm";
import { ModifyRentForm } from "./ModifyRentForm";
import { GuaranteeForm } from "./GuaranteeForm";
import { EndContractForm } from "./EndContractForm";
import { EditInfoForm } from "./EditInfoForm";
import { LedgerView } from "./LedgerView";

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
    queryKey: [apiBase + "/units", unit.id, "detail"],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units/${unit.id}/detail`, { credentials: "include" });
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
            {isShared && (
              <Badge className="bg-sky-600 text-white text-xs">
                Shared from {unit.ownerCompanyName ?? "another company"}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground">Loading…</div>
        ) : !contract ? (
          isShared ? (
            <div className="p-6 text-center text-muted-foreground text-sm">This is a read-only shared unit.</div>
          ) : (
            <Tabs defaultValue="contract" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="info" data-testid={`tab-${testIdPrefix}-unit-info`}>
                  <UserCog className="h-4 w-4 mr-1" />
                  Edit Info
                </TabsTrigger>
                <TabsTrigger value="contract" data-testid={`tab-${testIdPrefix}-new-contract`}>
                  <Plus className="h-4 w-4 mr-1" />
                  New Contract
                </TabsTrigger>
              </TabsList>
              <TabsContent value="info">
                <VacantUnitInfoForm unit={unit} testIdPrefix={testIdPrefix} />
              </TabsContent>
              <TabsContent value="contract">
                <StartContractForm unitId={unit.id} testIdPrefix={testIdPrefix} onClose={onClose} unitType={unitType} />
              </TabsContent>
            </Tabs>
          )
        ) : isShared ? (
          <Tabs defaultValue="payment" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="payment" data-testid={`tab-${testIdPrefix}-payment`}>
                <DollarSign className="h-4 w-4 mr-1" />
                Payment
              </TabsTrigger>
              <TabsTrigger value="ledger" data-testid={`tab-${testIdPrefix}-ledger`}>
                Statement
              </TabsTrigger>
            </TabsList>
            <TabsContent value="payment">
              <PaymentForm
                contract={contract}
                cashAccounts={cashAccounts}
                testIdPrefix={testIdPrefix}
                unitId={unit.id}
                ledger={detail?.ledger}
              />
            </TabsContent>
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
          <Tabs defaultValue="payment" className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-3 rounded-2xl sm:grid-cols-6 sm:rounded-full">
              <TabsTrigger value="payment" data-testid={`tab-${testIdPrefix}-payment`}>
                <DollarSign className="h-4 w-4 mr-1" />
                Payment
              </TabsTrigger>
              <TabsTrigger value="ledger" data-testid={`tab-${testIdPrefix}-ledger`}>
                Statement
              </TabsTrigger>
              <TabsTrigger value="edit" data-testid={`tab-${testIdPrefix}-edit`}>
                <UserCog className="h-4 w-4 mr-1" />
                Edit Info
              </TabsTrigger>
              <TabsTrigger value="modify" data-testid={`tab-${testIdPrefix}-modify`}>
                <FileEdit className="h-4 w-4 mr-1" />
                Modify Rent
              </TabsTrigger>
              <TabsTrigger value="guarantee" data-testid={`tab-${testIdPrefix}-guarantee`}>
                <Send className="h-4 w-4 mr-1" />
                Guarantee
              </TabsTrigger>
              <TabsTrigger value="end" data-testid={`tab-${testIdPrefix}-end`}>
                <XCircle className="h-4 w-4 mr-1" />
                End Contract
              </TabsTrigger>
            </TabsList>
            <TabsContent value="payment">
              <PaymentForm
                contract={contract}
                cashAccounts={cashAccounts}
                testIdPrefix={testIdPrefix}
                unitId={unit.id}
                ledger={detail?.ledger}
              />
            </TabsContent>
            <TabsContent value="ledger">
              <LedgerView
                ledger={detail?.ledger ?? []}
                postedPayments={detail?.postedPayments ?? []}
                scheduledPayments={detail?.scheduledPayments ?? []}
                guaranteePayments={detail?.guaranteePayments ?? []}
                contract={contract}
                unitId={unit.id}
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
