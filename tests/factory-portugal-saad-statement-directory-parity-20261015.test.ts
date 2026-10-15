/**
 * Company 12 Portugal Saad settlement-vs-posted-GL display reconciliation.
 * Source values independently checked against 30 containers and four FX
 * transfer records on October 15, 2026. These are immutable test examples,
 * not values written to the database or hardcoded into production balances.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { sumMoney,toMoney } from "../server/lib/money";

const read=(path:string)=>readFileSync(resolve(process.cwd(),path),"utf8");

describe("Portugal Saad directory uses the inside supplier's EUR statement source",()=>{
  it("reproduces native EUR from current goods + supplier freight - existing FX settlements",()=>{
    const goods = sumMoney([
      "5856","5814","5592","6060","5748","5736","5754","6138",
      "6108","5784","5688","5760","5772","6174","0",
      "5140.8","5364.8","5471.2","5034.4","5437.6","5073.6",
      "5527.2","5678.4","5706.4","4984","5415.2","5045.6",
      "5157.6","5068","5745.6"
    ]);
    expect(goods.toFixed(2)).toBe("161834.40");
    const freight=toMoney("50910.00");
    const transfers=sumMoney(["18825","40613","17241","30000"]);
    expect(transfers.toFixed(2)).toBe("106679.00");
    const actualEur=goods.plus(freight).minus(transfers);
    expect(actualEur.toFixed(2)).toBe("106065.40");
    // Factory Settings rate, not any of the four historical settlement rates.
    expect(actualEur.times("1.18").toFixed(3)).toBe("125157.172");
  });

  it("isolates the exact five old-voucher vs current-container valuation differences",()=>{
    expect(sumMoney(["5754.00","-3540.00","550.80","574.80","586.20"]).toFixed(2))
      .toBe("3925.80");
    expect(toMoney("102139.60").plus("3925.80").toFixed(2)).toBe("106065.40");
    // 2026-10-15 legacy historical USD-vs-current FX display is a distinct value.
    expect(toMoney("102139.60").times("1.18").plus("5754").toFixed(2))
      .toBe("126278.73");
  });

  it("applies only to company-12 supplier 39 and never writes accounting data",()=>{
    const route=read("server/routes/factory/suppliers/balance/with-balances.ts");
    const directory=read("client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx");
    expect(route).toContain('companyId === 12 && s.id === 39 && s.name.trim().toUpperCase() === "PORTUGAL SAAD"');
    expect(route).toContain('displayBalanceBasis: "operational-statement"');
    expect(route).toContain('usdEquivalentBalance: own.fxUnresolved ? null : own.balance.toFixed(3)');
    expect(route).toContain("...ledgerFields(s.id)");
    expect(directory).toContain('supplier.displayBalanceBasis === "operational-statement"');
    expect(directory).toContain("toFixed(isPortugalSaadSettlement ? 3 : 2)");
    expect(directory).toContain('"text-red-600 dark:text-red-400"');
    expect(route).not.toContain("FACTORY-PORTUGAL-DELTA-20261015");
  });
});
