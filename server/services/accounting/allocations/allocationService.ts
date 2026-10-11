/**
 * Open-item allocation service (accounting audit phase 25, AR-4).
 *
 *   - `syncOpenItemAllocationsTx`: the automatic FIFO run (fifoPlan.ts) for a
 *     company and party kind (or some parties): releases the rows that no
 *     longer fit (source changed) and writes the new FIFO rows, one audit row
 *     per party, and the allocation events (allocationEvents.ts, phase 24
 *     realized FX) in the same transaction.
 *   - `reallocateOpenItemsTx`: the manual re-allocation (Admin/Owner, checked
 *     by the route): releases chosen rows and writes chosen ones, each within
 *     what the two items still hold, with a reason, audited in the
 *     transaction. The FIFO run never releases a manual row unless its source
 *     changed.
 *   - `allocateNoteToInvoiceTx`: a credit / debit note that names its invoice
 *     (AR-7) is allocated to that invoice (method `note`).
 *
 * Runs of one company and kind are serialized by a transaction advisory lock.
 * Allocations do not post journals; nothing here touches the ledger.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { writeAuditEvent } from "../../audit/auditService";
import {
  onAllocationPostedTx,
  onAllocationReleasedTx,
  type AllocationEvent,
  type AllocationPartyKind,
} from "./allocationEvents";
import { planFifoAllocations, type AllocationMethod, type OpenItemState } from "./fifoPlan";
import { loadLiveAllocations, loadPartyOpenItems, OPENING_ITEM_KEY } from "./openItems";

export interface AllocationActor {
  userId: string;
  username: string;
}

const SYSTEM_ACTOR: AllocationActor = { userId: "system", username: "system" };

function voucherIdOf(key: string): number | null {
  return key === OPENING_ITEM_KEY ? null : Number(key);
}

async function lockKindTx(tx: DbTransaction, companyId: number, kind: AllocationPartyKind) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`open-items:${kind}`}), ${companyId})`);
}

/**
 * Every party kind's run lock of a company, in one statement and a fixed order
 * (the reviewed first run and the realized FX history tool).
 */
export async function lockAllOpenItemKindsTx(tx: DbTransaction, companyId: number): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext('open-items:' || kind), ${companyId})
      FROM unnest(ARRAY['customer', 'supplier', 'employee', 'factorySupplier']::text[]) WITH ORDINALITY AS k(kind, n)
     ORDER BY n
  `);
}

export async function companyBookCurrencyTx(tx: DbTransaction, companyId: number): Promise<string> {
  const result = await tx.execute<{ base_currency: string | null } & Record<string, unknown>>(
    sql`SELECT base_currency FROM companies WHERE id = ${companyId}`
  );
  return (result.rows[0]?.base_currency || "USD").toUpperCase().slice(0, 3);
}

interface InsertedRow {
  id: number;
  invoiceVoucherId: number | null;
  paymentVoucherId: number | null;
  amount: string;
}

async function insertAllocationTx(
  tx: DbTransaction,
  row: {
    companyId: number;
    kind: AllocationPartyKind;
    partyId: number;
    invoiceKey: string;
    paymentKey: string;
    amount: Decimal;
    currency: string;
    method: AllocationMethod;
    reason: string | null;
    actor: AllocationActor;
  }
): Promise<InsertedRow> {
  const invoiceVoucherId = voucherIdOf(row.invoiceKey);
  const paymentVoucherId = voucherIdOf(row.paymentKey);
  const amount = row.amount.toFixed(2);
  const result = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    INSERT INTO party_open_item_allocations
      (company_id, party_kind, party_id, invoice_voucher_id, payment_voucher_id, amount, currency, method, reason, created_by)
    VALUES (${row.companyId}, ${row.kind}, ${row.partyId}, ${invoiceVoucherId}, ${paymentVoucherId}, ${amount}::numeric,
            ${row.currency}, ${row.method}, ${row.reason}, ${row.actor.userId})
    RETURNING id
  `);
  const inserted = { id: Number(result.rows[0].id), invoiceVoucherId, paymentVoucherId, amount };
  const event: AllocationEvent = {
    companyId: row.companyId,
    allocationId: inserted.id,
    partyKind: row.kind,
    partyId: row.partyId,
    invoiceVoucherId,
    paymentVoucherId,
    amount,
    currency: row.currency,
    method: row.method,
  };
  await onAllocationPostedTx(tx, event);
  return inserted;
}

interface ReleasedRow {
  id: number;
  invoice_voucher_id: number | null;
  payment_voucher_id: number | null;
  amount: string;
  currency: string;
  method: AllocationMethod;
  party_id: number;
}

async function releaseAllocationsTx(
  tx: DbTransaction,
  query: {
    companyId: number;
    kind: AllocationPartyKind;
    ids: readonly number[];
    reason: string;
    actor: AllocationActor;
  }
): Promise<ReleasedRow[]> {
  if (query.ids.length === 0) return [];
  const result = await tx.execute<ReleasedRow & Record<string, unknown>>(sql`
    UPDATE party_open_item_allocations
       SET released_at = now(), released_by = ${query.actor.userId}, release_reason = ${query.reason}
     WHERE company_id = ${query.companyId} AND party_kind = ${query.kind} AND released_at IS NULL
       AND id IN (${sql.join(
         query.ids.map((id) => sql`${id}`),
         sql`, `
       )})
    RETURNING id, party_id, invoice_voucher_id, payment_voucher_id, amount::text AS amount, currency, method
  `);
  for (const row of result.rows) {
    await onAllocationReleasedTx(tx, {
      companyId: query.companyId,
      allocationId: Number(row.id),
      partyKind: query.kind,
      partyId: Number(row.party_id),
      invoiceVoucherId: row.invoice_voucher_id === null ? null : Number(row.invoice_voucher_id),
      paymentVoucherId: row.payment_voucher_id === null ? null : Number(row.payment_voucher_id),
      amount: toMoney(row.amount).toFixed(2),
      currency: row.currency,
      method: row.method,
      releaseReason: query.reason,
    });
  }
  return result.rows;
}

export interface SyncResult {
  companyId: number;
  kind: AllocationPartyKind;
  parties: number;
  created: number;
  released: number;
}

export interface PartyAllocationPlan {
  partyId: number;
  releases: number[];
  creates: { invoiceKey: string; paymentKey: string; amount: Decimal }[];
}

/**
 * The FIFO plan of a company and kind without writing anything (the reviewed
 * first run's preview, and the run itself). Callers that write hold the kind
 * lock first.
 */
export async function planOpenItemAllocationsTx(
  tx: DbTransaction,
  query: { companyId: number; kind: AllocationPartyKind; partyIds?: readonly number[] }
): Promise<PartyAllocationPlan[]> {
  const { companyId, kind } = query;
  // One transaction client: queries run one after the other.
  const parties = await loadPartyOpenItems(tx, { companyId, kind, partyIds: query.partyIds });
  const allocations = await loadLiveAllocations(tx, { companyId, kind, partyIds: query.partyIds });
  const byParty = new Map(parties.map((party) => [party.partyId, party]));
  const partyIds = new Set<number>([...byParty.keys(), ...allocations.keys()]);
  const plans: PartyAllocationPlan[] = [];
  for (const partyId of [...partyIds].sort((a, b) => a - b)) {
    const party = byParty.get(partyId);
    const plan = planFifoAllocations({
      invoices: party?.invoices ?? [],
      credits: party?.credits ?? [],
      allocations: allocations.get(partyId) ?? [],
      releaseMissing: true,
    });
    if (plan.releases.length === 0 && plan.creates.length === 0) continue;
    plans.push({ partyId, releases: [...plan.releases], creates: [...plan.creates] });
  }
  return plans;
}

/** The automatic FIFO run (see the header). */
export async function syncOpenItemAllocationsTx(
  tx: DbTransaction,
  query: { companyId: number; kind: AllocationPartyKind; partyIds?: readonly number[]; actor?: AllocationActor }
): Promise<SyncResult> {
  const { companyId, kind } = query;
  const actor = query.actor ?? SYSTEM_ACTOR;
  await lockKindTx(tx, companyId, kind);
  const plans = await planOpenItemAllocationsTx(tx, { companyId, kind, partyIds: query.partyIds });
  const currency = await companyBookCurrencyTx(tx, companyId);
  let created = 0;
  let released = 0;
  let touched = 0;
  for (const plan of plans) {
    const { partyId } = plan;
    touched += 1;
    const releasedRows = await releaseAllocationsTx(tx, {
      companyId,
      kind,
      ids: plan.releases,
      reason: "source_changed",
      actor,
    });
    const inserted: InsertedRow[] = [];
    for (const create of plan.creates) {
      inserted.push(
        await insertAllocationTx(tx, {
          companyId,
          kind,
          partyId,
          invoiceKey: create.invoiceKey,
          paymentKey: create.paymentKey,
          amount: create.amount,
          currency,
          method: "auto_fifo",
          reason: null,
          actor,
        })
      );
    }
    created += inserted.length;
    released += releasedRows.length;
    await writeAuditEvent(
      {
        userId: actor.userId,
        username: actor.username,
        companyId,
        action: "recalculate",
        tableName: "party_open_item_allocations",
        recordId: partyId,
        recordIdentifier: `${kind}:${partyId}`,
        changes: {
          released: { new: releasedRows.map((row) => ({ id: Number(row.id), amount: row.amount })) },
          allocated: { new: inserted },
        },
        reason: "Automatic FIFO allocation by due date",
      },
      tx
    );
  }
  return { companyId, kind, parties: touched, created, released };
}

export interface ManualAllocationInput {
  invoiceVoucherId: number | null;
  paymentVoucherId: number | null;
  amount: string;
}

export interface ReallocationResult {
  released: number[];
  created: number[];
}

function remainingOf(states: OpenItemState[], key: string): OpenItemState | undefined {
  return states.find((state) => state.item.key === key);
}

/** Manual re-allocation of one party's items (Admin/Owner; see the header). */
export async function reallocateOpenItemsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    kind: AllocationPartyKind;
    partyId: number;
    release: readonly number[];
    allocate: readonly ManualAllocationInput[];
    reason: string;
    actor: AllocationActor;
    method?: AllocationMethod;
  }
): Promise<ReallocationResult> {
  const { companyId, kind, partyId, actor } = input;
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(400, "A reason is required for a manual re-allocation");
  await lockKindTx(tx, companyId, kind);
  const live = (await loadLiveAllocations(tx, { companyId, kind, partyIds: [partyId] })).get(partyId) ?? [];
  const liveIds = new Set(live.map((row) => row.id));
  for (const id of input.release) {
    if (!liveIds.has(id)) throw new HttpError(409, `Allocation ${id} is not a live allocation of this party`);
  }
  const releasedRows = await releaseAllocationsTx(tx, {
    companyId,
    kind,
    ids: input.release,
    reason: `manual: ${reason}`.slice(0, 500),
    actor,
  });

  const [party] = await loadPartyOpenItems(tx, { companyId, kind, partyIds: [partyId] });
  const remainingLive = live.filter((row) => !input.release.includes(row.id));
  const state = planFifoAllocations({
    invoices: party?.invoices ?? [],
    credits: party?.credits ?? [],
    allocations: remainingLive,
    releaseMissing: false,
    allocate: false,
  });
  const currency = await companyBookCurrencyTx(tx, companyId);
  const created: number[] = [];
  for (const wanted of input.allocate) {
    const amount = toMoney(wanted.amount);
    if (!amount.isFinite() || !amount.greaterThan(0) || !amount.equals(amount.toDecimalPlaces(2))) {
      throw new HttpError(400, "Each allocation amount must be positive with at most 2 decimals");
    }
    const invoiceKey = wanted.invoiceVoucherId === null ? OPENING_ITEM_KEY : String(wanted.invoiceVoucherId);
    const paymentKey = wanted.paymentVoucherId === null ? OPENING_ITEM_KEY : String(wanted.paymentVoucherId);
    const invoice = remainingOf(state.invoices, invoiceKey);
    const credit = remainingOf(state.credits, paymentKey);
    if (!invoice) throw new HttpError(409, `Item ${invoiceKey} is not an open invoice of this party`);
    if (!credit) throw new HttpError(409, `Item ${paymentKey} is not a credit of this party`);
    if (amount.greaterThan(invoice.remaining) || amount.greaterThan(credit.remaining)) {
      throw new HttpError(
        409,
        `Allocation ${amount.toFixed(2)} exceeds what is open (invoice ${invoice.remaining.toFixed(2)}, credit ${credit.remaining.toFixed(2)})`
      );
    }
    invoice.remaining = invoice.remaining.minus(amount);
    credit.remaining = credit.remaining.minus(amount);
    const row = await insertAllocationTx(tx, {
      companyId,
      kind,
      partyId,
      invoiceKey,
      paymentKey,
      amount,
      currency,
      method: input.method ?? "manual",
      reason,
      actor,
    });
    created.push(row.id);
  }
  await writeAuditEvent(
    {
      userId: actor.userId,
      username: actor.username,
      companyId,
      action: "adjust",
      tableName: "party_open_item_allocations",
      recordId: partyId,
      recordIdentifier: `${kind}:${partyId}`,
      changes: {
        released: { new: releasedRows.map((row) => ({ id: Number(row.id), amount: row.amount })) },
        allocated: { new: { ids: created, rows: input.allocate } },
      },
      reason,
    },
    tx
  );
  return { released: releasedRows.map((row) => Number(row.id)), created };
}

/**
 * AR-7: a note that names its invoice is allocated to it, up to what the
 * invoice still holds (refused beyond). Returns the allocation id.
 */
export async function allocateNoteToInvoiceTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    kind: AllocationPartyKind;
    partyId: number;
    noteVoucherId: number;
    invoiceVoucherId: number;
    amount: Decimal;
    actor: AllocationActor;
  }
): Promise<number> {
  const result = await reallocateOpenItemsTx(tx, {
    companyId: input.companyId,
    kind: input.kind,
    partyId: input.partyId,
    release: await automaticRowsOnInvoiceTx(tx, input, input.amount),
    allocate: [
      {
        invoiceVoucherId: input.invoiceVoucherId,
        paymentVoucherId: input.noteVoucherId,
        amount: input.amount.toFixed(2),
      },
    ],
    reason: `Note ${input.noteVoucherId} against invoice ${input.invoiceVoucherId}`,
    actor: input.actor,
    method: "note",
  });
  return result.created[0];
}

/**
 * The automatic rows on the invoice to release so the note fits: newest
 * first, only as many as needed (the FIFO run re-allocates their credits).
 */
async function automaticRowsOnInvoiceTx(
  tx: DbTransaction,
  input: { companyId: number; kind: AllocationPartyKind; partyId: number; invoiceVoucherId: number },
  needed: Decimal
): Promise<number[]> {
  const [party] = await loadPartyOpenItems(tx, {
    companyId: input.companyId,
    kind: input.kind,
    partyIds: [input.partyId],
  });
  const invoice = party?.invoices.find((item) => item.voucherId === input.invoiceVoucherId);
  if (!invoice) return [];
  const live = (await loadLiveAllocations(tx, { ...input, partyIds: [input.partyId] })).get(input.partyId) ?? [];
  const onInvoice = live.filter((row) => row.invoiceKey === invoice.key);
  let remaining = invoice.amount.minus(onInvoice.reduce((sum, row) => sum.plus(row.amount), new MoneyDecimal(0)));
  const release: number[] = [];
  for (const row of onInvoice.filter((r) => r.method === "auto_fifo").sort((a, b) => b.sequence - a.sequence)) {
    if (!remaining.lessThan(needed)) break;
    release.push(row.id);
    remaining = remaining.plus(row.amount);
  }
  return release;
}
