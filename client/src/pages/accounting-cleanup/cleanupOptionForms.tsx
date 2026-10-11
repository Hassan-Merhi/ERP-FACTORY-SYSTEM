/**
 * The choices some Owner tools take before their preview or apply. Each form
 * only edits the tool's options; the plan URL and the apply body are built
 * from them in cleanupSteps.tsx.
 */
import type { ComponentType, ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type { PlanRecord } from "./cleanupPlanView";
import type { ToolOptionsProps } from "./cleanupTypes";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const text = (value: unknown): string => (typeof value === "string" ? value : "");

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <Label htmlFor={id} className="text-sm sm:min-w-40">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A single date input stored under `key`. */
export function dateOption(key: string, label: string, testId: string): ComponentType<ToolOptionsProps> {
  function DateOption({ options, setOption, disabled }: ToolOptionsProps) {
    return (
      <Field id={testId} label={label}>
        <Input
          id={testId}
          type="date"
          value={text(options[key])}
          onChange={(event) => setOption(key, event.target.value)}
          disabled={disabled}
          className="w-full sm:w-44"
          data-testid={`input-${testId}`}
        />
      </Field>
    );
  }
  return DateOption;
}

export function BackfillReversalOptions({ options, setOption, disabled }: ToolOptionsProps) {
  return (
    <div className="space-y-2">
      <Field id="backfill-offset" label="Contra account">
        <select
          id="backfill-offset"
          className={SELECT_CLASS}
          value={text(options.offset) || "OPENING_BALANCE_EQUITY"}
          onChange={(event) => setOption("offset", event.target.value)}
          disabled={disabled}
          data-testid="select-backfill-offset"
        >
          <option value="OPENING_BALANCE_EQUITY">OPENING_BALANCE_EQUITY</option>
          <option value="INVENTORY_ADJUSTMENT">INVENTORY_ADJUSTMENT</option>
        </select>
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id="backfill-allow"
          checked={options.allowNonSupplierPartner === true}
          onCheckedChange={(value) => setOption("allowNonSupplierPartner", value === true)}
          disabled={disabled}
          data-testid="checkbox-backfill-allow"
        />
        <Label htmlFor="backfill-allow" className="text-sm leading-snug">
          Reverse even though this company is not a supplier partner (the opening journal would otherwise absorb these
          lines)
        </Label>
      </div>
      {options.allowNonSupplierPartner === true && (
        <Field id="backfill-reason" label="Reason (at least 10 characters)">
          <Textarea
            id="backfill-reason"
            value={text(options.reason)}
            onChange={(event) => setOption("reason", event.target.value)}
            disabled={disabled}
            className="min-h-16"
            data-testid="input-backfill-reason"
          />
        </Field>
      )}
    </div>
  );
}

export function LegacyLineTargetOptions({ options, setOption, disabled }: ToolOptionsProps) {
  return (
    <Field id="legacy-line-target" label="Destination ledger account id (optional)">
      <Input
        id="legacy-line-target"
        inputMode="numeric"
        value={text(options.targetLedgerAccountId)}
        onChange={(event) => setOption("targetLedgerAccountId", event.target.value.replace(/\D/g, ""))}
        disabled={disabled}
        className="w-full sm:w-44"
        data-testid="input-legacy-line-target"
      />
    </Field>
  );
}

export function AccountReclassificationOptions({ options, setOption, disabled }: ToolOptionsProps) {
  return (
    <div className="space-y-2">
      <Field id="reclass-sources" label="Source account ids (comma separated)">
        <Input
          id="reclass-sources"
          value={text(options.sourceAccountIds)}
          onChange={(event) => setOption("sourceAccountIds", event.target.value.replace(/[^\d,\s]/g, ""))}
          disabled={disabled}
          className="w-full sm:w-64"
          data-testid="input-reclass-sources"
        />
      </Field>
      <Field id="reclass-destination" label="Destination account id">
        <Input
          id="reclass-destination"
          inputMode="numeric"
          value={text(options.destinationAccountId)}
          onChange={(event) => setOption("destinationAccountId", event.target.value.replace(/\D/g, ""))}
          disabled={disabled}
          className="w-full sm:w-44"
          data-testid="input-reclass-destination"
        />
      </Field>
      <Field id="reclass-date" label="Journal date">
        <Input
          id="reclass-date"
          type="date"
          value={text(options.date)}
          onChange={(event) => setOption("date", event.target.value)}
          disabled={disabled}
          className="w-full sm:w-44"
          data-testid="input-reclass-date"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="reclass-deactivate"
          checked={options.deactivateSources === true}
          onCheckedChange={(value) => setOption("deactivateSources", value === true)}
          disabled={disabled}
          data-testid="checkbox-reclass-deactivate"
        />
        <Label htmlFor="reclass-deactivate" className="text-sm">
          Deactivate the source accounts afterwards
        </Label>
      </div>
    </div>
  );
}

export function CrossCompanyLineOptions({ options, setOption, disabled }: ToolOptionsProps) {
  return (
    <div className="space-y-2">
      <Field id="cross-owner" label="Lines belong to">
        <select
          id="cross-owner"
          className={SELECT_CLASS}
          value={text(options.owner) || "account-company"}
          onChange={(event) => setOption("owner", event.target.value)}
          disabled={disabled}
          data-testid="select-cross-owner"
        >
          <option value="account-company">The account's company</option>
          <option value="voucher-company">The voucher's company</option>
        </select>
      </Field>
      <Field id="cross-map" label="Account map (JSON, optional)">
        <Input
          id="cross-map"
          value={text(options.accountMap)}
          placeholder='{"123": 456}'
          onChange={(event) => setOption("accountMap", event.target.value)}
          disabled={disabled}
          className="w-full font-mono sm:w-64"
          data-testid="input-cross-map"
        />
      </Field>
    </div>
  );
}

export const LEGACY_POSTING_FAMILIES = [
  ["v3Loads", "V3 loads"],
  ["commissions", "Commissions"],
  ["imports", "Containers and freight (import journals)"],
  ["noTargetLines", "Freight lines with no target"],
] as const;

export function LegacyPostingFamilyOptions({ options, setOption, disabled }: ToolOptionsProps) {
  const chosen = Array.isArray(options.families) ? (options.families as string[]) : [];
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm">Families to post (none ticked: all)</legend>
      {LEGACY_POSTING_FAMILIES.map(([family, label]) => (
        <div key={family} className="flex items-center gap-2">
          <Checkbox
            id={`family-${family}`}
            checked={chosen.includes(family)}
            onCheckedChange={(value) =>
              setOption("families", value === true ? [...chosen, family] : chosen.filter((entry) => entry !== family))
            }
            disabled={disabled}
            data-testid={`checkbox-family-${family}`}
          />
          <Label htmlFor={`family-${family}`} className="text-sm">
            {label}
          </Label>
        </div>
      ))}
    </fieldset>
  );
}

interface NoMixBale {
  baleId: number;
  referenceNumber: string;
  oldTotalCost: string;
  candidate: { mixBatchId: number; batchCode: string; newTotalCost: string } | null;
}

export function noMixBales(plan: PlanRecord | null): NoMixBale[] {
  return Array.isArray(plan?.bales) ? (plan.bales as NoMixBale[]) : [];
}

/** Per bale: assign to its candidate mix, write off to waste, or accept its cost with a sign-off. */
export function NoMixBaleOptions({ options, setOption, plan, disabled }: ToolOptionsProps) {
  const bales = noMixBales(plan);
  const actions = (options.actions ?? {}) as Record<string, string>;
  if (!plan) return <p className="text-xs text-muted-foreground">Preview to choose an action for each bale.</p>;
  return (
    <div className="space-y-2" data-testid="no-mix-options">
      {bales.slice(0, 200).map((bale) => (
        <div key={bale.baleId} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="font-mono text-sm sm:min-w-40" data-business-value>
            {bale.referenceNumber}
          </span>
          <select
            aria-label={`Action for bale ${bale.referenceNumber}`}
            className={SELECT_CLASS}
            value={actions[bale.baleId] ?? (bale.candidate ? "assign" : "")}
            onChange={(event) => setOption("actions", { ...actions, [bale.baleId]: event.target.value })}
            disabled={disabled}
            data-testid={`select-no-mix-${bale.baleId}`}
          >
            <option value="">Use the default below</option>
            {bale.candidate && <option value="assign">{`Assign to mix ${bale.candidate.batchCode}`}</option>}
            <option value="writeOff">Write off to waste</option>
            <option value="accept">Accept the cost (sign-off)</option>
          </select>
        </div>
      ))}
      <Field id="no-mix-unmatched" label="Bales without a choice">
        <select
          id="no-mix-unmatched"
          className={SELECT_CLASS}
          value={text(options.unmatched)}
          onChange={(event) => setOption("unmatched", event.target.value)}
          disabled={disabled}
          data-testid="select-no-mix-unmatched"
        >
          <option value="">No default</option>
          <option value="writeOff">Write off to waste</option>
          <option value="accept">Accept the cost (sign-off)</option>
        </select>
      </Field>
      <Field id="no-mix-reason" label="Sign-off reason (for accepted costs)">
        <Textarea
          id="no-mix-reason"
          value={text(options.reason)}
          onChange={(event) => setOption("reason", event.target.value)}
          disabled={disabled}
          className="min-h-16"
          data-testid="input-no-mix-reason"
        />
      </Field>
    </div>
  );
}

/** The apply actions for the no-mix bales and what is still missing. */
export function noMixChoices(plan: PlanRecord, options: Record<string, unknown>) {
  const actions = (options.actions ?? {}) as Record<string, string>;
  const unmatched = text(options.unmatched);
  const chosen = noMixBales(plan).map((bale) => {
    const action = actions[bale.baleId] || (bale.candidate ? "assign" : "");
    return {
      baleId: bale.baleId,
      action,
      mixBatchId: action === "assign" ? (bale.candidate?.mixBatchId ?? null) : null,
    };
  });
  const missing = chosen.some((entry) => !entry.action) && !unmatched;
  const accepts = chosen.some((entry) => entry.action === "accept") || unmatched === "accept";
  return {
    actions: chosen.filter((entry) => entry.action),
    unmatched: unmatched || null,
    reason: text(options.reason) || null,
    missingAction: missing,
    reasonMissing: accepts && text(options.reason).trim().length < 10,
  };
}

interface OrphanedLocation {
  locationId: number;
  items: number;
  value: string;
  sharedWithOtherCompanies: boolean;
}

export function orphanedLocations(plan: PlanRecord | null): OrphanedLocation[] {
  return Array.isArray(plan?.orphanedLocations) ? (plan.orphanedLocations as OrphanedLocation[]) : [];
}

/** Per missing location: restore it or write its stock off; and the anomalous values. */
export function ReadinessResolutionOptions({ options, setOption, plan, disabled }: ToolOptionsProps) {
  const actions = (options.actions ?? {}) as Record<string, string>;
  if (!plan) return <p className="text-xs text-muted-foreground">Preview to choose an action for each location.</p>;
  return (
    <div className="space-y-2" data-testid="readiness-options">
      {orphanedLocations(plan).map((location) => (
        <div key={location.locationId} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-sm sm:min-w-56">
            {`Location #${location.locationId}: ${location.items} items, ${location.value}`}
          </span>
          {location.sharedWithOtherCompanies ? (
            <span className="text-xs text-muted-foreground">Shared with other companies: not resolvable here</span>
          ) : (
            <select
              aria-label={`Action for location ${location.locationId}`}
              className={SELECT_CLASS}
              value={actions[location.locationId] ?? ""}
              onChange={(event) => setOption("actions", { ...actions, [location.locationId]: event.target.value })}
              disabled={disabled}
              data-testid={`select-readiness-${location.locationId}`}
            >
              <option value="">Leave as it is</option>
              <option value="restore">Restore the location</option>
              <option value="writeOff">Write the stock off</option>
            </select>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Checkbox
          id="readiness-anomalies"
          checked={options.writeOffAnomalies === true}
          onCheckedChange={(value) => setOption("writeOffAnomalies", value === true)}
          disabled={disabled}
          data-testid="checkbox-readiness-anomalies"
        />
        <Label htmlFor="readiness-anomalies" className="text-sm">
          Write off the anomalous values on existing locations
        </Label>
      </div>
    </div>
  );
}

export function readinessChoices(options: Record<string, unknown>) {
  const actions = (options.actions ?? {}) as Record<string, string>;
  return {
    actions: Object.entries(actions)
      .filter(([, action]) => action === "restore" || action === "writeOff")
      .map(([locationId, action]) => ({ locationId: Number(locationId), action })),
    writeOffAnomalies: options.writeOffAnomalies === true,
  };
}
