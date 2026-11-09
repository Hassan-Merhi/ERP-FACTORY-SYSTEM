import {describe,expect,it} from "vitest";
import {verifyPosJnahPrepaidMonths,type PosJnahMonth} from "../server/startup/posJnahPrepaidPlan";
const snapshot=(after=false):PosJnahMonth[]=>Array.from({length:12},(_,i)=>({
 id:701216+i,contract_id:36,unit_id:59,year:i<5?2026:2027,month:(7+i)%12+1,
 expected_amount:"2500.00",paid_amount:"2500.00",
 accrual_voucher_id:i===1?13142:i===2?15041:after&&i===0?13141:after&&i===3?15040:null,
 used_prepaid_account:after||i===1||i===2||i>=4,used_advance_account:false
}));
describe("POS Jnah historical rent reconciliation",()=>{
 it("identifies August/November existing vouchers, no new voucher",()=>{
  expect(verifyPosJnahPrepaidMonths(snapshot(),"before")).toEqual([{id:701216,voucherId:13141},{id:701219,voucherId:15040}]);
  expect(verifyPosJnahPrepaidMonths(snapshot(true),"after")).toHaveLength(2);
 });
 it("refuses drifted payment allocations and accrual stamps",()=>{
  const months=snapshot();months[5].paid_amount="0";
  expect(()=>verifyPosJnahPrepaidMonths(months,"before")).toThrow("MONTH_DRIFT");
  const duplicate=snapshot();duplicate[0].accrual_voucher_id=1234;
  expect(()=>verifyPosJnahPrepaidMonths(duplicate,"before")).toThrow("MONTH_DRIFT");
 });
});
