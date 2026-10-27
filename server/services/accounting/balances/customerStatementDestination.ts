/**
 * Read-only destination projection for Factory customer account statements.
 *
 * Destinations live on customer_orders or factory_containers, not voucher_entries.
 * Only associate invoices with orders belonging to this customer, and exact
 * container-number charges with records in this company. Ambiguous matches
 * remain blank; no accounting amounts or voucher records are changed.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrders, factoryContainers } from "@shared/schema";

type DestinationStatementRow = {
  voucherNumber?: string | null;
  voucherDescription?: string | null;
  narration?: string | null;
};

export async function enrichCustomerLedgerDestinations<T extends DestinationStatementRow>(
  companyId: number,
  customerId: number,
  rows: T[]
): Promise<Array<T & { destination: string | null }>> {
  if (!rows.length) return [];

  const orders = await db
    .select({
      id: customerOrders.id,
      invoiceNumber: customerOrders.invoiceNumber,
      containerNumber: customerOrders.containerNumber,
      destination: customerOrders.destination,
    })
    .from(customerOrders)
    .where(and(
      eq(customerOrders.companyId, companyId),
      eq(customerOrders.customerId, customerId),
      isNull(customerOrders.deletedAt)
    ));

  const byOrderId = new Map<number, string>();
  const byInvoiceNumber = new Map<string, string>();
  const byContainer = new Map<string, string | null>();
  const registerContainer = (number: string | null | undefined, destination: string) => {
    const key = number?.trim().toUpperCase();
    if (!key) return;
    if (!byContainer.has(key)) byContainer.set(key, destination);
    else if (byContainer.get(key) !== destination) byContainer.set(key, null);
  };

  for (const order of orders) {
    const destination = order.destination?.trim();
    if (!destination) continue;
    byOrderId.set(order.id, destination);
    if (order.invoiceNumber) byInvoiceNumber.set(order.invoiceNumber.trim().toUpperCase(), destination);
    registerContainer(order.containerNumber, destination);
  }

  // Freight and clearance often reference the ISO container number instead of
  // an invoice. Fetch only referenced containers, scoped to this company.
  const extractNumbers = (value: string) => value.toUpperCase().match(/\b[A-Z]{4}\d{7}\b/g) ?? [];
  const referencedContainers = [...new Set(rows.flatMap((row) =>
    [row.voucherNumber ?? "", row.voucherDescription ?? "", row.narration ?? ""]
      .flatMap(extractNumbers)
  ))];
  if (referencedContainers.length) {
    const containers = await db
      .select({
        containerNumber: factoryContainers.containerNumber,
        destination: factoryContainers.destination,
      })
      .from(factoryContainers)
      .where(and(
        eq(factoryContainers.companyId, companyId),
        inArray(factoryContainers.containerNumber, referencedContainers),
        isNull(factoryContainers.deletedAt)
      ));
    for (const container of containers) {
      const destination = container.destination?.trim();
      if (destination) registerContainer(container.containerNumber, destination);
    }
  }

  return rows.map((row) => {
    const voucherNumber = (row.voucherNumber ?? "").trim().toUpperCase();
    const description = (row.voucherDescription ?? "").trim().toUpperCase();
    const narration = (row.narration ?? "").trim().toUpperCase();

    // Canonical invoice voucher: INV-GL-{companyId}-{orderId}.
    const glInvoice = /^INV-GL-(\d+)-(\d+)$/.exec(voucherNumber);
    const canonicalDestination = glInvoice && Number(glInvoice[1]) === companyId
      ? byOrderId.get(Number(glInvoice[2]))
      : undefined;

    // Match exact invoice numbers in invoice descriptions, references, and
    // charge vouchers, rather than guessing from a customer's entire history.
    const invoiceReference = [voucherNumber, description, narration]
      .filter((value) =>
        value.startsWith("FACTORY INVOICE") ||
        value.startsWith("INVOICE INV-") ||
        value.startsWith("INV-") ||
        value.startsWith("CHARGE-")
      )
      .join(" ");
    const invoiceIds = invoiceReference.match(/INV-\d+/g) ?? [];
    const matchedDestinations = new Set(
      invoiceIds.map((id) => byInvoiceNumber.get(id)).filter((v): v is string => !!v)
    );
    const containerNumbers = [voucherNumber, description, narration].flatMap(extractNumbers);
    const containerDestinations = new Set(
      containerNumbers.map((number) => byContainer.get(number)).filter((v): v is string => !!v)
    );

    const destination = canonicalDestination ??
      (matchedDestinations.size === 1 ? [...matchedDestinations][0] : null) ??
      (containerDestinations.size === 1 ? [...containerDestinations][0] : null);
    return { ...row, destination: destination ?? null };
  });
}
