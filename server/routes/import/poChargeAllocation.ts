import type Decimal from "decimal.js";
import { allocateCents, MoneyDecimal, sumMoney, toMoney, type MoneyInput } from "../../lib/money";

export interface ContainerCharges {
  freight: MoneyInput;
  surcharge: MoneyInput;
  fumigation: MoneyInput;
  documentCharges: MoneyInput;
  discount: MoneyInput;
  otherCharges: MoneyInput;
}

export interface PoChargeSplit {
  itemsTotal: Decimal;
  freight: Decimal;
  surcharge: Decimal;
  fumigation: Decimal;
  documentCharges: Decimal;
  discount: Decimal;
  otherCharges: Decimal;
  /** Items plus every charge, less the discount. */
  grandTotal: Decimal;
  /** The grand total without freight, which the parent pays when freight is parent-paid. */
  intercoTotal: Decimal;
}

/**
 * Split a container's charges across its purchase orders in proportion to
 * each PO's item value, exactly to the cent: every charge's PO shares add up
 * to the container charge. When no PO has item value the whole charge lands on
 * the last PO, as it always has.
 */
export function allocatePoCharges(
  poLineTotals: ReadonlyArray<ReadonlyArray<MoneyInput>>,
  charges: ContainerCharges,
  freightPaidByParent: boolean
): PoChargeSplit[] {
  const itemsTotals = poLineTotals.map((lines) => sumMoney(lines));
  const hasItemValue = sumMoney(itemsTotals).gt(0);
  const split = (total: MoneyInput): Decimal[] => {
    if (hasItemValue) return allocateCents(itemsTotals, total);
    const exact = toMoney(total).toDecimalPlaces(2);
    return itemsTotals.map((_, index) => (index === itemsTotals.length - 1 ? exact : new MoneyDecimal(0)));
  };

  const freight = split(charges.freight);
  const surcharge = split(charges.surcharge);
  const fumigation = split(charges.fumigation);
  const documentCharges = split(charges.documentCharges);
  const discount = split(charges.discount);
  const otherCharges = split(charges.otherCharges);

  return itemsTotals.map((itemsTotal, index) => {
    const withoutFreight = itemsTotal
      .plus(surcharge[index])
      .plus(fumigation[index])
      .plus(documentCharges[index])
      .minus(discount[index])
      .plus(otherCharges[index]);
    const grandTotal = withoutFreight.plus(freight[index]);
    return {
      itemsTotal,
      freight: freight[index],
      surcharge: surcharge[index],
      fumigation: fumigation[index],
      documentCharges: documentCharges[index],
      discount: discount[index],
      otherCharges: otherCharges[index],
      grandTotal,
      intercoTotal: freightPaidByParent && freight[index].gt(0) ? withoutFreight : grandTotal,
    };
  });
}
