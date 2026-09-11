import { and, eq } from "drizzle-orm";
import { containers, containerSales, insertContainerSaleSchema } from "@shared/schema";

import { db } from "../../db";
import {
  buildContainerSalePostingRequest,
  createDatabasePostingDependencies,
  postBalancedVoucherTx,
  type PostingActor,
} from "../../services/accounting";
import { storage } from "../../storage";

const postingDependencies = createDatabasePostingDependencies();

export class ContainerSaleRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ContainerSaleRouteError";
  }
}

async function resolveCommissionAccountId(companyId: number, requestedAccountId?: number | null): Promise<number> {
  if (requestedAccountId) {
    const commissionAccount = await storage.getLedgerAccountById(requestedAccountId);
    if (!commissionAccount) {
      throw new ContainerSaleRouteError(404, "Commission account not found");
    }
    if (commissionAccount.companyId !== companyId) {
      throw new ContainerSaleRouteError(403, "Commission account belongs to a different company");
    }
    return commissionAccount.id;
  }

  const accounts = await storage.getAllLedgerAccounts(companyId);
  let commissionAccount = accounts.find((account) => account.code === "COMMISSION_REVENUE");
  if (!commissionAccount) {
    commissionAccount = await storage.createLedgerAccount({
      companyId,
      code: "COMMISSION_REVENUE",
      name: "Commission Revenue",
      accountType: "Income",
      openingBalance: "0",
      active: true,
    });
  }
  return commissionAccount.id;
}

export const containerSalesService = {
  list(companyId: number) {
    return storage.getContainerSales(companyId);
  },

  listByCustomer(customerId: number, companyId: number) {
    return storage.getContainerSalesByCustomer(customerId, companyId);
  },

  async create(companyId: number, input: unknown, actor?: PostingActor) {
    const parsed = insertContainerSaleSchema.parse({
      ...(input && typeof input === "object" ? input : {}),
      companyId,
    });

    const [customer, container, existingSale] = await Promise.all([
      storage.getCustomerById(parsed.customerId),
      storage.getContainerById(parsed.containerId),
      storage.getContainerSaleByContainerId(parsed.containerId, companyId),
    ]);
    if (existingSale) return existingSale;
    if (!customer) throw new ContainerSaleRouteError(404, "Customer not found");
    if (customer.companyId !== companyId) {
      throw new ContainerSaleRouteError(403, "Customer belongs to a different company");
    }
    if (!container) throw new ContainerSaleRouteError(404, "Container not found");
    if (container.companyId !== companyId) {
      throw new ContainerSaleRouteError(403, "Container belongs to a different company");
    }
    if (!customer.ledgerAccountId) {
      throw new ContainerSaleRouteError(400, "Customer does not have a ledger account");
    }
    const customerLedgerAccountId = customer.ledgerAccountId;

    const commissionAccountId = await resolveCommissionAccountId(companyId, parsed.commissionAccountId);
    return db.transaction(async (tx) => {
      const [currentSale] = await tx
        .select()
        .from(containerSales)
        .where(and(eq(containerSales.companyId, companyId), eq(containerSales.containerId, parsed.containerId)))
        .limit(1);
      if (currentSale) return currentSale;

      const voucherNumber = `CS-${Date.now()}`;
      const description = parsed.notes || `Container sale - ${container.containerNumber} to ${customer.legalName}`;
      const built = buildContainerSalePostingRequest({
        companyId,
        containerId: parsed.containerId,
        voucherNumber,
        voucherDate: parsed.saleDate,
        description,
        debitNarration: `Container sale - ${voucherNumber}`,
        creditNarration: `Container sale commission - ${voucherNumber}`,
        totalAmount: parsed.totalAmount,
        customerLedgerAccountId,
        commissionAccountId,
        actor: actor ?? { reason: "Container sale posting" },
      });
      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);

      const [replayedSale] = await tx
        .select()
        .from(containerSales)
        .where(
          and(
            eq(containerSales.companyId, companyId),
            eq(containerSales.voucherId, Number((posted.voucher as { id: unknown }).id))
          )
        )
        .limit(1);
      if (replayedSale) return replayedSale;

      const [createdSale] = await tx
        .insert(containerSales)
        .values({
          ...parsed,
          commissionAccountId,
          voucherId: (posted.voucher as { id: number }).id,
        })
        .returning();

      await tx
        .update(containers)
        .set({ status: "SOLD" })
        .where(and(eq(containers.id, parsed.containerId), eq(containers.companyId, companyId)));
      return createdSale;
    });
  },
};
