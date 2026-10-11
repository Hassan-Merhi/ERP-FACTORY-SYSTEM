/**
 * The Owner production steps, in the order they must be done (docs/accounting-
 * audit-2026-10.md sections 9 and 13, "Owner how-to"). Every tool calls an
 * existing audited route; the routes, bodies and roles are the server's
 * (server/routes/accounting-integrity/*, rental, insurance, SP, open items,
 * factory bale re-cost). Nothing here posts by itself.
 */
import { Link } from "wouter";

import { FxRatesCard } from "@/pages/settings/FxRatesCard";

import { ErpExchangeRatesCard } from "./ErpExchangeRatesCard";
import { FiscalCloseCheck } from "./FiscalCloseCheck";
import {
  AccountReclassificationOptions,
  BackfillReversalOptions,
  CrossCompanyLineOptions,
  LegacyLineTargetOptions,
  LegacyPostingFamilyOptions,
  NoMixBaleOptions,
  ReadinessResolutionOptions,
  dateOption,
  noMixChoices,
  readinessChoices,
  text,
} from "./cleanupOptionForms";
import type { PlanRecord } from "./cleanupPlanView";
import type { CleanupStep, CleanupTool, StepExtraProps, ToolOptions } from "./cleanupTypes";

const OWNER = ["Owner"] as const;
const ADMIN_OWNER = ["Admin", "Owner"] as const;

/** Builds `path?key=value` from the defined, non-empty parameters. */
export function toolUrl(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (options: ToolOptions, key: string) =>
  ISO_DATE.test(text(options[key])) ? text(options[key]) : null;
const list = (plan: PlanRecord, key: string) => (Array.isArray(plan[key]) ? (plan[key] as unknown[]) : []);
const count = (plan: PlanRecord, key: string) => list(plan, key).length;

/** System accounts the page ensures: the required ones and the two FX accounts phase 24 posts to. */
export const CLEANUP_SYSTEM_ACCOUNT_CODES = [
  "RETAINED_EARNINGS",
  "OPENING_BALANCE_EQUITY",
  "ROUNDING",
  "ACCOUNTS_RECEIVABLE",
  "ACCOUNTS_PAYABLE",
  "PAYROLL_PAYABLE",
  "FX_GAIN_LOSS",
  "UNREALIZED_FX",
] as const;

const systemAccounts: CleanupTool = {
  key: "system-accounts",
  title: "Required system accounts",
  description:
    "Lists RETAINED_EARNINGS, OPENING_BALANCE_EQUITY, ROUNDING, the receivable, payable and payroll control accounts and the two FX accounts; Apply creates the missing ones.",
  previewRoles: ADMIN_OWNER,
  applyRoles: ADMIN_OWNER,
  planUrl: () => "/api/accounting/system-accounts",
  applyUrl: "/api/accounting/system-accounts/ensure",
  sendsPlanHash: false,
  applyBody: () => ({ codes: [...CLEANUP_SYSTEM_ACCOUNT_CODES] }),
  isEmpty: (plan) =>
    list(plan, "statuses").every(
      (status) =>
        !CLEANUP_SYSTEM_ACCOUNT_CODES.includes((status as { code: string }).code as never) ||
        (status as { state: string }).state !== "missing"
    ),
  omit: ["definitions"],
};

function PlugInvestigationLink({ modePrefix }: StepExtraProps) {
  return (
    <p className="flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:gap-2">
      <Link
        href={`${modePrefix}/import-cycle-diagnostics`}
        className="text-primary underline-offset-2 hover:underline"
        data-testid="link-import-cycle-diagnostics"
      >
        Open Import Cycle Diagnostics
      </Link>
      <span className="text-muted-foreground">
        Investigate each company's import-cycle difference there and post the reviewed corrections first.
      </span>
    </p>
  );
}

function DatedRatesExtra({ mode, role }: StepExtraProps) {
  const canEdit = ["Admin", "Owner", "Developer"].includes(role);
  if (mode === "factory") return <FxRatesCard />;
  return <ErpExchangeRatesCard canEdit={canEdit} />;
}

function FiscalCloseExtra({ role }: StepExtraProps) {
  return <FiscalCloseCheck role={role} />;
}

const backfillBlockers: Record<string, string> = {
  NOT_SUPPLIER_PARTNER:
    "This company is not a supplier partner: the opening inventory journal absorbs its backfill lines. Reverse them only with an explicit request and a reason.",
  REASON_REQUIRED: "A reason of at least 10 characters is required to reverse the backfill of this company.",
  OFFSET_ACCOUNT_UNAVAILABLE: "The contra account of the reversal is deleted; restore it before applying.",
  PERIOD_CLOSED: "The reversal date is in a closed fiscal period.",
};

const backfillOptions = (options: ToolOptions) => ({
  offset: text(options.offset) || "OPENING_BALANCE_EQUITY",
  allowNonSupplierPartner: options.allowNonSupplierPartner === true,
  reason: options.allowNonSupplierPartner === true ? text(options.reason) : "",
});

const openingJournalBlockers: Record<string, string> = {
  CUT_OVER_DATE_REQUIRED: "A cut-over date (YYYY-MM-DD) is required.",
  CLOSED_PERIOD_EXISTS: "The company has a closed fiscal period; its openings are frozen. Reopen it first.",
  NOT_USD: "The company's base currency is not USD; the opening journal is posted in USD only.",
  SYSTEM_ACCOUNT_UNAVAILABLE: "OPENING_BALANCE_EQUITY or RETAINED_EARNINGS is deleted or missing.",
};

const reclassificationBlockers: Record<string, string> = {
  DATE_REQUIRED: "A reclassification date (YYYY-MM-DD) is required.",
  SOURCES_REQUIRED: "Choose between 1 and 200 source accounts.",
  SOURCE_INVALID: "A source account is not a live leaf ledger account of this company.",
  DESTINATION_INVALID: "The destination must be a live, active leaf ledger account of this company, not a source.",
  CUSTOMER_LINKED_SOURCE: "A customer's linked ledger account is the customer's sub-ledger and cannot be reclassified.",
  CLOSED_PERIOD: "The reclassification date is in a closed fiscal period.",
};

const reclassificationRequest = (options: ToolOptions) => ({
  sourceAccountIds: text(options.sourceAccountIds)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(","),
  destinationAccountId: text(options.destinationAccountId),
  date: dateParam(options, "date") ?? "",
  deactivateSources: options.deactivateSources === true,
});

const openingReceivableBlockers: Record<string, string> = {
  CUTOVER_IN_FUTURE: "The factory receivable cut-over can be applied on or after its date.",
  INVOICES_WITHOUT_RATE:
    "Some invoices are in a currency with no confirmed exchange rate on or before their date. Enter the factory rates first.",
};

const noMixBlockers: Record<string, string> = {
  ACTION_REQUIRED: "Choose an action (assign, write off or accept) for every bale without a candidate mix.",
  REASON_REQUIRED: "Accepting a bale's cost needs a sign-off reason of at least 10 characters.",
};

function crossCompanyParams(options: ToolOptions) {
  const accountMap = text(options.accountMap).trim();
  return { owner: text(options.owner) || "account-company", accountMap: accountMap || null };
}

function parsedAccountMap(options: ToolOptions): Record<string, number> | null {
  const raw = text(options.accountMap).trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : null;
  } catch {
    return null;
  }
}

export const CLEANUP_STEPS: CleanupStep[] = [
  {
    step: 1,
    key: "system-accounts",
    title: "Required system accounts",
    explanation:
      "Every company needs these accounts before the other tools can post: retained earnings for the close, rounding for cents, the control accounts and the FX accounts.",
    never: "It never renames, retypes, restores or deletes an existing account; it only creates missing ones.",
    perCompany: true,
    tools: [systemAccounts],
  },
  {
    step: 2,
    key: "dated-rates",
    title: "Dated exchange rates",
    explanation:
      "Enter or import the rate of every date on which foreign-currency documents exist (back to February 2026). The prepared ECB table can be imported as it is; the preview shows which rows are new, identical or differ from a recorded rate.",
    never:
      "It never accepts a rate dated after today and never changes a rate silently: a differing rate is replaced only when you tick it.",
    perCompany: true,
    tools: [],
    Extra: DatedRatesExtra,
  },
  {
    step: 3,
    key: "factory-fx-repair",
    title: "Factory FX repair",
    explanation:
      "Converts legacy factory foreign-currency lines at their voucher's stored rate, or the dated factory rate entered in step 2.",
    never: "It never guesses a rate: lines with no rate are listed and skipped.",
    perCompany: true,
    tools: [
      {
        key: "factory-fx-repair",
        title: "Legacy factory FX lines",
        description: "Preview the lines it converts, by target, with the USD change; apply the reviewed plan.",
        previewRoles: ADMIN_OWNER,
        applyRoles: ["Admin"],
        applyRoleHint:
          "Applying is a maintenance action: an Admin with the repair permission applies it after the Owner reviews the preview.",
        planUrl: () => "/api/accounting/factory-fx-repair",
        applyUrl: "/api/accounting/factory-fx-repair/apply",
        isEmpty: (plan) => Number(plan.repairableLines ?? 0) === 0,
      },
    ],
  },
  {
    step: 4,
    key: "plug-values",
    title: "Plug values",
    explanation:
      "The stored equity adjustment hid each company's import-cycle difference. Investigate the difference, post the reviewed corrections, then clear the stored value.",
    never: "Clearing never posts a journal and never changes a balance: it removes the stored figure, audited.",
    perCompany: true,
    Extra: PlugInvestigationLink,
    tools: [
      {
        key: "legacy-equity-plug",
        title: "Clear the stored equity adjustment",
        description: "Shows the stored value and the live import-cycle difference it hid.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/accounting/legacy-equity-plug/plan",
        applyUrl: "/api/accounting/legacy-equity-plug/apply",
      },
    ],
  },
  {
    step: 5,
    key: "backfill-reversal",
    title: "Backfill reversal (company 10)",
    explanation:
      "Reverses the INVENTORY lines the old boot backfill added to stock adjustment vouchers of a supplier-partner company, with a reversing journal against the contra account you choose.",
    never:
      "For other companies it refuses unless you tick the override and give a reason; it never edits the original vouchers.",
    perCompany: true,
    tools: [
      {
        key: "backfill-reversal",
        title: "Stock adjustment backfill lines",
        description: "Preview per voucher the reversing journal; the reason and the override are part of the plan.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        defaultOptions: { offset: "OPENING_BALANCE_EQUITY", allowNonSupplierPartner: false, reason: "" },
        Options: BackfillReversalOptions,
        planUrl: (options) => {
          const chosen = backfillOptions(options);
          return toolUrl("/api/accounting/stock-adjustment-inventory-mirror-reversal/plan", {
            offset: chosen.offset,
            allowNonSupplierPartner: chosen.allowNonSupplierPartner ? "true" : null,
            reason: chosen.reason || null,
          });
        },
        applyUrl: "/api/accounting/stock-adjustment-inventory-mirror-reversal/apply",
        applyBody: (_plan, options) => {
          const chosen = backfillOptions(options);
          return { ...chosen, reason: chosen.reason || null };
        },
        blockerText: backfillBlockers,
      },
    ],
  },
  {
    step: 6,
    key: "insurance-direction",
    title: "Insurance journal direction",
    explanation:
      "Old generated insurance journals were posted the wrong way round; the tool swaps debit and credit on those vouchers.",
    never:
      "It never touches a voucher whose pattern is not proven or that is in a closed period: those are listed as skipped.",
    perCompany: true,
    tools: [
      {
        key: "insurance-direction",
        title: "Reversed insurance journals",
        description: "Preview each voucher and line before and after.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/insurance/admin/journal-direction/plan",
        applyUrl: "/api/insurance/admin/journal-direction/apply",
        isEmpty: (plan) => count(plan, "candidates") === 0,
      },
    ],
  },
  {
    step: 7,
    key: "rental",
    title: "Rent: legacy prepaid recognition and deferred rent",
    explanation:
      "Recognises the legacy fully prepaid shop rent months the daily job used to post, and (Properties companies) moves the Deferred Rent Revenue balance to Rental Income.",
    never: "It never posts into a closed period and never guesses an ambiguous month: those are listed as skipped.",
    perCompany: true,
    tools: [
      {
        key: "erp-prepaid-rent",
        title: "ERP shops: legacy prepaid rent",
        description: "Preview the reclassification and recognition journal of each month.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/erp/rental/admin/legacy-prepaid-recognition/plan",
        applyUrl: "/api/erp/rental/admin/legacy-prepaid-recognition/apply",
        modes: ["erp"],
      },
      {
        key: "factory-prepaid-rent",
        title: "Factory shops: legacy prepaid rent",
        description: "Preview the reclassification and recognition journal of each month.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/factory/rental/admin/legacy-prepaid-recognition/plan",
        applyUrl: "/api/factory/rental/admin/legacy-prepaid-recognition/apply",
        modes: ["factory"],
      },
      {
        key: "deferred-rent",
        title: "Properties: deferred rent reclassification",
        description: "Should be empty; preview to confirm. Applies to Properties companies only.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/properties/rental/admin/deferred-rent-reclassification/plan",
        applyUrl: "/api/properties/rental/admin/deferred-rent-reclassification/apply",
        modes: ["erp"],
        blockerText: {
          INCOME_ACCOUNT_MISSING:
            "The Deferred Rent Revenue account has a balance but the company has no Rental Income account (RENT-INC).",
          PERIOD_CLOSED: "The reclassification date is in a closed fiscal period.",
        },
      },
    ],
  },
  {
    step: 8,
    key: "phase3-historical",
    title: "Phase 3 historical repair",
    explanation:
      "Adds the missing Purchases debits of legacy purchase orders and the missing inventory legs of notes, rebuilds unbalanced payroll periods and removes company 1's duplicate POS lines.",
    never: "It never changes a voucher in a closed period; each change is in the plan before it is applied.",
    perCompany: true,
    tools: [
      {
        key: "phase3-historical",
        title: "Historical voucher repair",
        description: "Preview every voucher it completes.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/accounting/phase3-historical/plan",
        applyUrl: "/api/accounting/phase3-historical/apply",
        isEmpty: (plan) =>
          count(plan, "purchaseDebits") === 0 &&
          count(plan, "noteInventoryLegs") === 0 &&
          count(plan, "payrollPeriods") === 0 &&
          !plan.duplicatePosEntries &&
          !plan.legacyMarker,
      },
    ],
  },
  {
    step: 9,
    key: "sp-supplier-links",
    title: "Supplier Partner voucher links",
    explanation: "Sets the supplier on Supplier Partner goods-in-transit vouchers whose lines name the wrong supplier.",
    never: "It never changes amounts and skips vouchers in a closed period.",
    perCompany: true,
    tools: [
      {
        key: "sp-supplier-links",
        title: "Goods-in-transit supplier links",
        description: "Preview each voucher and line whose supplier would change.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/sp/admin/supplier-voucher-links/plan",
        applyUrl: "/api/sp/admin/supplier-voucher-links/apply",
        isEmpty: (plan) => count(plan, "vouchers") === 0,
      },
    ],
  },
  {
    step: 10,
    key: "ledger-model",
    title: "Chart of accounts: legacy lines, opening journal, reclassification",
    explanation:
      "Moves legacy lines on missing, deleted or other companies' accounts to a reviewed account, then validates the ledger constraints; posts the openings as one opening journal at the cut-over date; moves account balances by a reclassification journal.",
    never: "None of them edits a posted line in place: each posts a journal, and the opening journal is applied once.",
    perCompany: true,
    tools: [
      {
        key: "legacy-line-reclassification",
        title: "Legacy line reclassification",
        description: "Preview the lines by kind and the reclassification journal; optional destination account.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: LegacyLineTargetOptions,
        planUrl: (options) =>
          toolUrl("/api/accounting/legacy-line-reclassification/plan", {
            targetLedgerAccountId: text(options.targetLedgerAccountId) || null,
          }),
        applyUrl: "/api/accounting/legacy-line-reclassification/apply",
        applyBody: (_plan, options) => ({
          targetLedgerAccountId: text(options.targetLedgerAccountId) ? Number(options.targetLedgerAccountId) : null,
        }),
        blockerText: { TARGET_INVALID: "The destination must be a live, active leaf ledger account of this company." },
      },
      {
        key: "validate-ledger-constraints",
        title: "Validate the ledger constraints",
        description:
          "After the legacy lines are reclassified: validates the ledger guard constraints wherever no line breaks them any more, and lists the others.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        actionOnly: true,
        planUrl: () => null,
        applyUrl: "/api/accounting/legacy-line-reclassification/validate-constraints",
      },
      {
        key: "opening-journal",
        title: "Opening journal",
        description: "Choose the cut-over date (suggested in the plan), preview the journal, apply once.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: dateOption("cutOverDate", "Cut-over date", "opening-journal-date"),
        planUrl: (options) =>
          toolUrl("/api/accounting/opening-journal/plan", { cutOverDate: dateParam(options, "cutOverDate") }),
        applyUrl: "/api/accounting/opening-journal/apply",
        applyBody: (plan) => ({ cutOverDate: text(plan.cutOverDate) }),
        isApplied: (plan) => !!plan.applied,
        blockerText: openingJournalBlockers,
      },
      {
        key: "account-reclassification",
        title: "Account reclassification",
        description: "Moves the balances of source accounts on a date to one destination account by a journal.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: AccountReclassificationOptions,
        inputHint: "Enter the source accounts, the destination account and the date to preview.",
        planUrl: (options) => {
          const request = reclassificationRequest(options);
          if (!request.sourceAccountIds || !request.destinationAccountId || !request.date) return null;
          return toolUrl("/api/accounting/account-reclassification/plan", {
            ...request,
            deactivateSources: request.deactivateSources ? "true" : null,
          });
        },
        applyUrl: "/api/accounting/account-reclassification/apply",
        applyBody: (_plan, options) => {
          const request = reclassificationRequest(options);
          return {
            ...request,
            sourceAccountIds: request.sourceAccountIds.split(",").map(Number),
            destinationAccountId: Number(request.destinationAccountId),
          };
        },
        blockerText: reclassificationBlockers,
      },
    ],
  },
  {
    step: 11,
    key: "fx-revaluation",
    title: "Month-end FX revaluation",
    explanation:
      "Revalues every foreign-currency monetary balance at the rate recorded on the month end, posted to UNREALIZED_FX and reversed on the first day of the next month.",
    never:
      "It never revalues a currency with no rate on the month end (listed as rate missing) and is applied once per month.",
    perCompany: true,
    tools: [
      {
        key: "fx-revaluation",
        title: "Revaluation at a month end",
        description: "Choose the month end, preview the adjustments and the currencies with no rate.",
        previewRoles: OWNER,
        applyRoles: OWNER,
        Options: dateOption("monthEnd", "Month end", "fx-revaluation-month-end"),
        inputHint: "Choose the month end to preview.",
        planUrl: (options) => {
          const monthEnd = dateParam(options, "monthEnd");
          return monthEnd ? toolUrl("/api/accounting/fx-revaluation/preview", { monthEnd }) : null;
        },
        applyUrl: "/api/accounting/fx-revaluation/apply",
        applyBody: (plan) => ({ monthEnd: text(plan.monthEnd) }),
        isEmpty: (plan) => count(plan, "lines") === 0,
        isApplied: (plan) => !!plan.alreadyApplied,
      },
    ],
  },
  {
    step: 12,
    key: "open-items",
    title: "Open items: first allocation and realized FX history",
    explanation:
      "The first allocation run of a company (receipts and notes matched to invoices, oldest due first) is the Owner's; it also turns on the hourly run. Then review the realized FX of the history it allocated.",
    never: "The first run posts no FX journal; the history tool posts only the differences in its plan.",
    perCompany: true,
    tools: [
      {
        key: "open-items-allocation",
        title: "First allocation run",
        description: "Preview per party kind the allocations it creates and releases.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/open-items/allocate/preview",
        applyUrl: "/api/open-items/allocate",
        isApplied: (plan) => !!plan.enabled,
      },
      {
        key: "realized-fx-history",
        title: "Realized FX of allocated history",
        description: "Preview the exchange difference of each allocation between foreign-currency documents.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/accounting/realized-fx/history/plan",
        applyUrl: "/api/accounting/realized-fx/history/apply",
        isEmpty: (plan) => count(plan, "items") === 0,
      },
      {
        key: "open-items-diagnostics",
        title: "Open-items diagnostics",
        description: "Read only: the customer balance memo, employee cache, book amount column and allocation tie-out.",
        previewRoles: ADMIN_OWNER,
        applyRoles: [],
        planUrl: () => "/api/open-items/diagnostics",
      },
    ],
  },
  {
    step: 13,
    key: "multi-company",
    title: "Multi-company: company 13 lines and diagnostic",
    explanation:
      "Lines a voucher posted to another company's account are corrected by reversal and re-post in the right company; the diagnostic lists what is left.",
    never: "It never edits a line in place and leaves blocked vouchers as they are, with the reason.",
    perCompany: true,
    tools: [
      {
        key: "cross-company-lines",
        title: "Cross-company lines",
        description: "Choose who owns the lines and, if needed, an account map; preview per voucher.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        defaultOptions: { owner: "account-company", accountMap: "" },
        Options: CrossCompanyLineOptions,
        inputHint: "The account map must be a JSON object of account ids.",
        planUrl: (options) =>
          parsedAccountMap(options) === null
            ? null
            : toolUrl("/api/accounting/cross-company-lines/plan", crossCompanyParams(options)),
        applyUrl: "/api/accounting/cross-company-lines/apply",
        applyBody: (_plan, options) => ({
          owner: crossCompanyParams(options).owner,
          accountMap: parsedAccountMap(options) ?? {},
        }),
        isEmpty: (plan) => Number((plan.totals as PlanRecord | undefined)?.correctable ?? 0) === 0,
      },
      {
        key: "multi-company-diagnostic",
        title: "Multi-company diagnostic",
        description: "Read only: intercompany links, parents and cross-company lines.",
        previewRoles: ADMIN_OWNER,
        applyRoles: [],
        planUrl: () => "/api/accounting/multi-company/diagnostic",
      },
    ],
  },
  {
    step: 14,
    key: "go-live",
    title: "Factory and inventory go-live (not the switch)",
    explanation:
      "In order: opening receivable at the cut-over, no-mix bales, back-fill of legacy factory postings, bale re-cost, bale-mirror write-off, readiness resolution, then the opening plan, readiness and reconciliation. The perpetual switch itself stays a code flag.",
    never: "Nothing here turns perpetual posting on.",
    perCompany: true,
    tools: [
      {
        key: "factory-opening-receivable",
        modes: ["factory"],
        title: "Factory opening receivable",
        description: "Choose the receivable cut-over date; preview the opening journal per currency.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: dateOption("effectiveFrom", "Cut-over date", "opening-receivable-date"),
        inputHint: "Choose the cut-over date to preview.",
        planUrl: (options) => {
          const effectiveFrom = dateParam(options, "effectiveFrom");
          return effectiveFrom ? toolUrl("/api/accounting/factory-opening-receivable/plan", { effectiveFrom }) : null;
        },
        applyUrl: "/api/accounting/factory-opening-receivable/apply",
        applyBody: (plan) => ({ effectiveFrom: text(plan.effectiveFrom) }),
        isApplied: (plan) => !!plan.alreadyApplied,
        blockerText: openingReceivableBlockers,
      },
      {
        key: "no-mix-bales",
        modes: ["factory"],
        title: "Bales without a costed mix",
        description:
          "For each bale: assign to its candidate mix, write off to waste, or accept its cost with a sign-off.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: NoMixBaleOptions,
        planUrl: () => "/api/accounting/factory-no-mix-bales/plan",
        applyUrl: "/api/accounting/factory-no-mix-bales/apply",
        applyBody: (plan, options) => {
          const { actions, unmatched, reason } = noMixChoices(plan, options);
          return { actions, unmatched, reason };
        },
        isEmpty: (plan) => count(plan, "bales") === 0,
        clientBlockers: (plan, options) => {
          const choices = noMixChoices(plan, options);
          return [
            ...(choices.missingAction ? ["ACTION_REQUIRED"] : []),
            ...(choices.reasonMissing ? ["REASON_REQUIRED"] : []),
          ];
        },
        blockerText: noMixBlockers,
      },
      {
        key: "factory-legacy-postings",
        modes: ["factory"],
        title: "Back-fill legacy factory postings",
        description: "V3 loads, commissions, container import journals and freight lines with no target.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: LegacyPostingFamilyOptions,
        planUrl: () => "/api/accounting/factory-legacy-postings/plan",
        applyUrl: "/api/accounting/factory-legacy-postings/apply",
        applyBody: (_plan, options) => {
          const families = Array.isArray(options.families) ? (options.families as string[]) : [];
          return families.length > 0 ? { families } : {};
        },
        isEmpty: (plan) => count(plan, "items") === 0,
      },
      {
        key: "bale-recost",
        modes: ["factory"],
        title: "Bale re-cost",
        description: "Preview per mix and bale the old and new USD cost; apply the reviewed plan.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/factory/bale-cost/recost-preview",
        applyUrl: "/api/factory/bale-cost/recost-apply",
        isEmpty: (plan) => count(plan, "mixes") === 0 && count(plan, "bales") === 0,
      },
      {
        key: "bale-mirror-write-off",
        modes: ["erp"],
        title: "ERP bale-mirror write-off",
        description: "Writes off the values left on the ERP bale-mirror stock rows.",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        planUrl: () => "/api/accounting/bale-mirror-write-off/plan",
        applyUrl: "/api/accounting/bale-mirror-write-off/apply",
        isEmpty: (plan) => count(plan, "rows") === 0,
      },
      {
        key: "readiness-resolution",
        title: "Readiness resolution",
        description: "Stock at missing locations (restore or write off) and anomalous values (write off).",
        previewRoles: ADMIN_OWNER,
        applyRoles: OWNER,
        Options: ReadinessResolutionOptions,
        planUrl: () => "/api/accounting/perpetual-inventory/readiness-resolution",
        applyUrl: "/api/accounting/perpetual-inventory/readiness-resolution/apply",
        applyBody: (_plan, options) => readinessChoices(options),
        isEmpty: (plan) => count(plan, "orphanedLocations") === 0 && count(plan, "anomalies") === 0,
        clientBlockers: (_plan, options) => {
          const choices = readinessChoices(options);
          return choices.actions.length === 0 && !choices.writeOffAnomalies ? ["ACTION_REQUIRED"] : [];
        },
      },
      {
        key: "perpetual-opening-plan",
        title: "Perpetual opening plan",
        description:
          "Read only: the opening inventory journal the cut-over would post (applied with the switch, in code).",
        previewRoles: ADMIN_OWNER,
        applyRoles: [],
        Options: dateOption("effectiveFrom", "Cut-over date", "perpetual-opening-date"),
        planUrl: (options) =>
          toolUrl("/api/accounting/perpetual-inventory/opening-plan", {
            effectiveFrom: dateParam(options, "effectiveFrom"),
          }),
      },
      {
        key: "perpetual-readiness",
        title: "Perpetual readiness",
        description: "Read only: every blocker left before the cut-over.",
        previewRoles: ADMIN_OWNER,
        applyRoles: [],
        planUrl: () => "/api/accounting/perpetual-inventory/readiness",
      },
      {
        key: "perpetual-reconciliation",
        title: "Reconciliation",
        description: "Read only: the ledger against the stock sub-ledgers, account by account.",
        previewRoles: ADMIN_OWNER,
        applyRoles: [],
        planUrl: () => "/api/accounting/perpetual-inventory/reconciliation",
      },
    ],
  },
  {
    step: 15,
    key: "fiscal-close",
    title: "First fiscal close",
    explanation:
      "Check that the trial balance is balanced, RETAINED_EARNINGS exists and no account of an unknown type carries a balance, then close the period with the existing close and reopen flow.",
    never: "The pre-check changes nothing; the close posts the closing journal and turns the period lock on.",
    perCompany: true,
    tools: [],
    Extra: FiscalCloseExtra,
  },
];
