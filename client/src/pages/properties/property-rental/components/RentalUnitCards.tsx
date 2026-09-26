import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErpMobileRecordCard, ErpMobileRecordGroup, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import type { Unit } from "../types";
import { fmtMoneyCurrency } from "../utils";

interface RentalUnitCardsProps {
  grouped: Array<[string, Unit[]]>;
  selectedContractIds: Set<number>;
  onToggleSelect: (contractId: number) => void;
  onOpenUnit: (unitId: number) => void;
  onDeleteUnit: (unitId: number) => void;
}

/**
 * Phone presentation of the rental units table: one card per unit, grouped by location. The card
 * shows the same figures as the table row (tenant, rent, outstanding or credit, guarantee, next
 * billing); tapping it opens the existing unit dialog, where payments and contract changes live.
 */
export function RentalUnitCards({
  grouped,
  selectedContractIds,
  onToggleSelect,
  onOpenUnit,
  onDeleteUnit,
}: RentalUnitCardsProps) {
  return (
    <div className="space-y-4" data-testid="rental-unit-cards">
      {grouped.map(([group, groupUnits]) => (
        <ErpMobileRecordGroup key={group} label={group} meta={groupUnits.length} data-testid={`group-units-${group}`}>
          <ErpMobileRecordList>
            {groupUnits.map((unit) => (
              <RentalUnitCard
                key={unit.id}
                unit={unit}
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
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  unit: Unit;
  selected: boolean;
  onToggleSelect: (contractId: number) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const contract = unit.contract;
  const currency = contract?.currency;
  const outstanding = unit.outstanding ?? 0;
  const credit = unit.prepaidCredit ?? 0;
  const guarantee = unit.guaranteeRemaining ?? contract?.guaranteeAmount;
  const selectable = !!contract && !unit.isShared;
  const dimensions = unit.dimensions || unit.size;

  const balance =
    unit.outstanding === null
      ? null
      : outstanding > 0
        ? {
            label: "Outstanding",
            text: fmtMoneyCurrency(outstanding, currency),
            tone: "text-red-600 dark:text-red-400",
          }
        : credit > 0
          ? { label: "Credit", text: fmtMoneyCurrency(credit, currency), tone: "text-green-600 dark:text-green-400" }
          : { label: "Outstanding", text: fmtMoneyCurrency(0, currency), tone: "text-muted-foreground" };

  return (
    <ErpMobileRecordCard
      data-testid={`card-unit-${unit.id}`}
      title={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-mono">{unit.unitNumber}</span>
          <span className="min-w-0 break-words font-medium">{contract ? contract.tenantName : null}</span>
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
          {unit.isShared && <Badge className="bg-sky-600 text-xs text-white">Shared</Badge>}
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
                label: "Guarantee",
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
              ...(contract.notes ? [{ label: "Note", value: contract.notes, wide: true }] : []),
            ]
          : []
      }
      onOpen={onOpen}
      openLabel={`Open unit ${unit.unitNumber}`}
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
                onClick={onDelete}
                aria-label={`Delete unit ${unit.unitNumber}`}
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
