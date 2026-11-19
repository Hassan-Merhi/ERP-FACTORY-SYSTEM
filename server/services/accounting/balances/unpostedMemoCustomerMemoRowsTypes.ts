// Extracted from ./unpostedMemoCustomerMemoRows.ts
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";

export type MemoPartyKind = "customer" | "factorySupplier";

export type MemoSource =
  | "factoryInvoice"
  | "factoryPosCreditSale"
  | "factoryPosDeposit"
  | "customerBalanceCache"
  | "factoryContainerGoods"
  | "factoryContainerFreight"
  | "factoryContainerCommission"
  | "factoryRawStockCommission"
  | "factoryCommissionRecord";

/** An amount that belongs next to a party's balance but is not in the ledger. */
export interface PartyBalanceMemoLine {
  source: MemoSource;
  /** The operational document: invoice number, cache reference, container number. */
  reference: string | null;
  /** The row it comes from (order, customer_balances row, container id). */
  sourceId: number;
  /** YYYY-MM-DD. */
  date: string;
  /** USD, debit positive (owed to us positive); null when no rate is stored for its currency. */
  amount: string | null;
  /** The amount in its own currency, debit positive. */
  nativeAmount: string;
  currency: string;
  /** Human-readable label: what the amount is and why it is not in the ledger. */
  label: string;
  /** Always true: the line is outside the ledger balance. */
  notInLedger: true;
}

export interface MemoQuery {
  knownAt?: FactoryNetPositionAsOf;
  companyId: number;
  kind: MemoPartyKind;
  ids: readonly number[];
  asOf?: string | null;
}

export type Executor = DatabaseOrTransaction;

export type NumberCondition = (voucherNumber: ReturnType<typeof sql>) => ReturnType<typeof sql>;

export interface CustomerMemoRow {
  party_id: number;
  source: MemoSource;
  reference: string | null;
  source_id: number;
  date: string;
  native: string;
  currency: string | null;
  extra: string | null;
}

export interface ContainerMemoRow {
  id: number;
  container_number: string;
  supplier_id: number | null;
  /** The party the commission is owed to: the commission supplier, else the container's supplier. */
  commission_party_id: number | null;
  date: string;
  status: string | null;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  goods: string | null;
  goods_posted: boolean;
  opening_already_in_supplier_master: boolean;
  freight: string | null;
  freight_currency_code: string | null;
  freight_fx_rate_to_usd: string | null;
  freight_fx_rate_confirmed: boolean | null;
  freight_paid_by: string | null;
  freight_supplier_id: number | null;
  freight_posted: boolean;
  commission_amount: string | null;
  commission_currency_code: string | null;
  commission_fx_rate_to_usd: string | null;
  commission_fx_rate_confirmed: boolean | null;
  commission_posted: boolean;
}
