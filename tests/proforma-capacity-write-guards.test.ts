import { describe, expect, it, vi } from "vitest";
import type { ProformaCapacityExecutor } from "../server/routes/factory/customer-orders/proformaCapacity";
import {
  guardExistingOrderProformaLink,
  guardProformaOrderCreation,
} from "../server/routes/factory/customer-orders/proformaCapacityWriteGuards";

const proforma = {
  id: 71,
  customerId: 23,
  name: "MALI 18 AUG (PROFORMA)",
  isActive: true,
  status: "ACTIVE",
};

function executorWith(...rows: unknown[][]): { executor: ProformaCapacityExecutor; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  for (const resultRows of rows) execute.mockResolvedValueOnce({ rows: resultRows });
  return { executor: { execute } as unknown as ProformaCapacityExecutor, execute };
}

describe("Phase 2 proforma write guards", () => {
  it("rejects a missing proforma before a linked loading/order is created", async () => {
    const { executor, execute } = executorWith([]);

    await expect(
      guardProformaOrderCreation(executor, { companyId: 12, proformaId: 71, customerId: 23 })
    ).resolves.toEqual({
      allowed: false,
      status: 404,
      body: { message: "Proforma not found" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows creation for the selected customer while the proforma is active", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 4 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 2 }]
    );

    await expect(
      guardProformaOrderCreation(executor, { companyId: 12, proformaId: 71, customerId: 23 })
    ).resolves.toEqual({ allowed: true });
  });

  it("allows a new loading even when sibling loadings already consumed the full proforma quantity", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 2 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "VERIFIED", loadedQty: 2 }]
    );

    await expect(
      guardProformaOrderCreation(executor, { companyId: 12, proformaId: 71, customerId: 23 })
    ).resolves.toEqual({ allowed: true });
  });

  it("rejects linking an existing loading when one loaded article is outside the proforma", async () => {
    const { executor, execute } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 3 }],
      [],
      [{ articleCode: "EXTRA", quantity: 1 }]
    );

    const result = await guardExistingOrderProformaLink(executor, {
      companyId: 12,
      proformaId: 71,
      customerId: 23,
      orderId: 170,
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        status: 400,
        body: expect.objectContaining({
          message: "Existing loaded bales exceed or do not match the selected proforma capacity",
          capacityIssues: [expect.objectContaining({ reason: "not_in_proforma", normalizedArticleCode: "extra" })],
        }),
      })
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("permits linking existing bales even when sibling loadings already filled the same proforma", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 5 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 5 }],
      [{ articleCode: "A", quantity: 3 }]
    );

    await expect(
      guardExistingOrderProformaLink(executor, {
        companyId: 12,
        proformaId: 71,
        customerId: 23,
        orderId: 170,
      })
    ).resolves.toEqual({ allowed: true });
  });

  it("still rejects linking when this loading itself exceeds a proforma line", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 5 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 100 }],
      [{ articleCode: "A", quantity: 6 }]
    );

    const result = await guardExistingOrderProformaLink(executor, {
      companyId: 12,
      proformaId: 71,
      customerId: 23,
      orderId: 170,
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        status: 400,
        body: expect.objectContaining({
          capacityIssues: [
            expect.objectContaining({
              reason: "quantity_exceeded",
              normalizedArticleCode: "a",
              requestedQty: 5,
              requestedAdditionalQty: 6,
            }),
          ],
        }),
      })
    );
  });
});
