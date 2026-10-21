/**
 * Historical Rental payment FX rate (Phase 5 shared date/rate resolver).
 * Stored ERP transaction convention: native currency units per 1 base USD.
 */
import Decimal from "decimal.js";
import { db, type DbTransaction } from "../../db";
import { datedMonetaryRateTx, fxCurrency } from "../accounting/monetaryFxRates";

/** A rate refusal that carries the HTTP status and missing pair. */
export type RentalRateRequiredError=Error&{status:number;code:string;currency:string;date:string};
export const RENTAL_RATE_REQUIRED_CODE="RENTAL_RATE_REQUIRED" as const;
export const RENTAL_RATE_REQUIRED_MESSAGE=
  "No exchange rate is recorded for this currency on or before the payment date. Enter the dated rate before posting the payment.";
export function isRentalRateRequiredError(error:unknown):error is RentalRateRequiredError{
  return (error as {code?:unknown}|null)?.code===RENTAL_RATE_REQUIRED_CODE;
}
/**
 * Read a company-scoped dated rate, with no client override and no fallback.
 * Pass the rental caller's tx so rate evidence and payment posting share the
 * same snapshot. Existing three-argument callers remain supported.
 */
export async function recordedRentalPaymentRate(
  companyId:number,currency:string,date:string,existingTx?:DbTransaction
):Promise<string>{
  const code=fxCurrency(currency||"USD");
  if(code==="USD")return "1";
  const day=String(date).slice(0,10);
  const rate=existingTx
    ?await datedMonetaryRateTx(existingTx,companyId,code,day)
    :await db.transaction(tx=>datedMonetaryRateTx(tx,companyId,code,day));
  if(rate)return new Decimal(rate.rateUnitPerBase).toString();
  const error=new Error(RENTAL_RATE_REQUIRED_MESSAGE) as RentalRateRequiredError;
  error.status=409;error.code=RENTAL_RATE_REQUIRED_CODE;
  error.currency=code;error.date=day;
  throw error;
}
