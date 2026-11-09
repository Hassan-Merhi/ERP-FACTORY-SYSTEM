import { format } from "date-fns";
import { Trash2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErpMobileRecordCard, ErpMobileRecordGroup, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import type { Unit } from "../types";
import { fmtMoneyCurrency } from "../utils";
import { NoteCell } from "./NoteCell";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

interface RentalUnitCardsProps {
  landlordView?: boolean;
  grouped: Array<[string, Unit[]]>;
  selectedContractIds: Set<number>;
  onToggleSelect: (contractId: number) => void;
  onOpenUnit: (unitId: number) => void;
  onDeleteUnit: (unitId: number) => void;
  onRenameGroup?: (group: string, groupUnits: Unit[]) => void;
  canRenameGroup?: (groupUnits: Unit[]) => boolean;
}

/**
 * Phone presentation of the rental units table: one card per unit, grouped by location. The card
 * shows the same figures as the table row (tenant, rent, outstanding or credit, guarantee, next
 * billing); tapping it opens the existing unit dialog, where payments and contract changes live.
 */
export function RentalUnitCards({
  grouped,
  landlordView = false,
  selectedContractIds,
  onToggleSelect,
  onOpenUnit,
  onDeleteUnit,
  onRenameGroup,
  canRenameGroup,
}: RentalUnitCardsProps) {
  return (
    <div className="space-y-4" data-testid="rental-unit-cards">
      {grouped.map(([group, groupUnits]) => (
        <ErpMobileRecordGroup
          key={group}
          label={
            <span className="inline-flex items-center gap-2">
              <span>{group}</span>
              {onRenameGroup && canRenameGroup?.(groupUnits) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Rename location group ${group}`}
                  onClick={() => onRenameGroup(group, groupUnits)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </span>
          }
          meta={groupUnits.length}
          data-testid={`group-units-${group}`}
        >
          <ErpMobileRecordList>
            {groupUnits.map((unit) => (
              <RentalUnitCard
                key={unit.id}
                unit={unit}
                landlordView={landlordView}
                selected={!!unit.contract && selectedContractIds.has(unit.contract.id)}
                onToggleSelect={onToggleSelect}
                onOpen={() => onOpenUnit(unit.id)}
                onDelete={() => onDeleteUnit(unit.id)}
              />
            ))}
          </ErpMobileRecordList>
        </ErpMobileRecordGroup>
      ))}
    </div>
  );
}

function RentalUnitCard({
  unit,
  landlordView,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  unit: Unit;
  landlordView: boolean;
  selected: boolean;
  onToggleSelect: (contractId: number) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // View Only and Create Only cannot delete existing units.
  const deleteDisabledReason = useExistingRecordChangeAccess().reason;
  const contract = unit.contract;
  const currency = contract?.currency;
  const outstanding = unit.outstanding ?? 0;
  const credit = unit.prepaidCredit ?? 0;
  const guarantee = unit.guaranteeRemaining ?? contract?.guaranteeAmount;
  const selectable = !!contract && !unit.isShared && !unit.isInternalLeaseProjection;
  const dimensions = unit.dimensions || unit.size;

  const balance =
    unit.outstanding === null
      ? null
      : outstanding > 0
        ? {
            label: unit.isInternalLeaseProjection
              ? "Source balance (reference)"
              : landlordView
                ? "To collect"
                : "Outstanding",
            text: fmtMoneyCurrency(outstanding, currency),
            tone: unit.isInternalLeaseProjection
              ? "text-muted-foreground"
              : landlordView
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400",
          }
        : credit > 0
          ? {
              label: unit.isInternalLeaseProjection
                ? "Source credit (reference)"
                : landlordView
                  ? "Owed to tenant"
                  : "Credit",
              text: fmtMoneyCurrency(credit, currency),
              tone: unit.isInternalLeaseProjection
                ? "text-muted-foreground"
                : landlordView
                  ? "text-red-600 dark:text-red-400"
                  : "text-green-600 dark:text-green-400",
            }
          : { label: "Outstanding", text: fmtMoneyCurrency(0, currency), tone: "text-muted-foreground" };

  return (
    <ErpMobileRecordCard
      data-testid={`card-unit-${unit.id}`}
      title={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-mono">{unit.unitNumber}</span>
          <span className="min-w-0 wrap-break-word font-medium">{contract ? contract.tenantName : null}</span>
        </span>
      }
      subtitle={dimensions || undefined}
      badges={
        <>
          {!contract && (
            <Badge variant="secondary" className="text-xs">
              Vacant
            </Badge>
          )}
          {contract?.isInternal && <Badge className="bg-violet-600 text-xs text-white">Internal</Badge>}
          {unit.isInternalLeaseProjection ? (
            <Badge className="bg-violet-600 text-xs text-white">
              {unit.sourceModule === "ERP" ? "ERP reference" : "Factory reference"}
            </Badge>
          ) : unit.isShared ? (
            <Badge className="bg-sky-600 text-xs text-white">Shared</Badge>
          ) : null}
        </>
      }
      value={
        balance ? (
          <span className={`block ${balance.tone}`}>
            <span className="block text-[11px] font-medium uppercase tracking-wide opacity-80" data-i18n-ui="">
              {balance.label}
            </span>
            {balance.text}
          </span>
        ) : undefined
      }
      fields={
        contract
          ? [
              { label: "Monthly Rent", value: fmtMoneyCurrency(contract.rentalAmount, currency), numeric: true },
              {
                label: "Next Billing",
                value: unit.nextBillingDate ? format(new Date(unit.nextBillingDate + "T00:00:00Z"), "dd MMM") : "—",
              },
              {
                label: landlordView ? "Guarantee held" : "Guarantee",
                value: guarantee != null ? fmtMoneyCurrency(guarantee, currency) : "—",
                numeric: true,
              },
              { label: "Start", value: format(new Date(contract.startDate), "dd MMM yyyy") },
            ]
          : []
      }
      details={
        contract
          ? [
              {
                label: "Scheduled",
                value: (unit.scheduledAmount ?? 0) > 0 ? fmtMoneyCurrency(unit.scheduledAmount, currency) : "—",
                numeric: true,
              },
            ]
          : []
      }
      onOpen={onOpen}
      openLabel={`Open unit ${unit.unitNumber}`}
      // The contract note stays editable in place, as in the table's Note column.
      children={
        contract ? (
          <div className="min-w-0 rounded-md border border-dashed px-2.5 py-2 [&>div]:max-w-none">
            <div
              className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              data-i18n-ui=""
            >
              Note
            </div>
            {unit.isInternalLeaseProjection ? (
              <p className="text-sm">{contract.notes || "—"}</p>
            ) : (
              <NoteCell contractId={contract.id} note={contract.notes} testId={`unit-${unit.id}`} />
            )}
          </div>
        ) : undefined
      }
      selected={selected}
      actions={
        selectable || !unit.isShared ? (
          <>
            {selectable && (
              <label className="me-auto flex min-h-10 cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => onToggleSelect(contract.id)}
                  data-testid={`checkbox-unit-${unit.id}`}
                />
                <span>Select for payment</span>
              </label>
            )}
            {!unit.isShared && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-10 w-10 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (!deleteDisabledReason) onDelete();
                }}
                disabled={!!deleteDisabledReason}
                title={deleteDisabledReason ?? undefined}
                aria-label={deleteDisabledReason ?? `Delete unit ${unit.unitNumber}`}
                data-testid={`button-delete-unit-${unit.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
