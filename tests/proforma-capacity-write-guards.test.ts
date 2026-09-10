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

  it("allows creation only while the selected customer has remaining active capacity", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 4 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 2 }]
    );

    await expect(
      guardProformaOrderCreation(executor, { companyId: 12, proformaId: 71, customerId: 23 })
    ).resolves.toEqual({ allowed: true });
  });

  it("blocks creation when the target proforma is already fully consumed", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 2 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "VERIFIED", loadedQty: 2 }]
    );

    const result = await guardProformaOrderCreation(executor, {
      companyId: 12,
      proformaId: 71,
      customerId: 23,
    });
    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        status: 400,
        body: expect.objectContaining({ message: "Proforma has no remaining loading capacity" }),
      })
    );
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

  it("permits linking existing bales that fit the target proforma's remaining global capacity", async () => {
    const { executor } = executorWith(
      [proforma],
      [{ articleCode: "A", quantity: 5 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 2 }],
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
});
