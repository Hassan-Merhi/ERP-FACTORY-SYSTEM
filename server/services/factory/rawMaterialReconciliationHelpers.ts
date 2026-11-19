// Extracted from ./rawMaterialReconciliation.ts: shared helpers.
import { toMoney } from "../../lib/money";

// The report returns numbers; every sum and product is taken exactly first.
export const amountOf = (value: string | null | undefined) => toMoney(value).toNumber();

export const plus = (a: number, b: number) => toMoney(a).plus(b).toNumber();

export const minus = (a: number, b: number) => toMoney(a).minus(b).toNumber();

export const times = (a: number, b: number) => toMoney(a).times(b).toNumber();

export const EPS = 0.01;
