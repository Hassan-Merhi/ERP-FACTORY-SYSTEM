import { beforeEach, describe, expect, it, vi } from "vitest";
import { factoryApiRequest } from "@/lib/factoryApi";
import { ensureDatedAutoFxRate } from "@/pages/factory/factory-containers/ContainerFormDialog";

vi.mock("@/lib/factoryApi", () => ({
  factoryApiRequest: vi.fn(),
}));

const request = vi.mocked(factoryApiRequest);
const reply = (data: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as Awaited<ReturnType<typeof factoryApiRequest>>;

describe("container auto FX rate confirmation", () => {
  beforeEach(() => request.mockReset());

  it("uses the arrival date and does not save an already confirmed rate", async () => {
    request.mockResolvedValueOnce(reply({ saved: true, source: "manual", rate: "1.18" }));
    await ensureDatedAutoFxRate("EUR", "2026-10-01");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET", "/api/factory/fx-rates/EUR/2026-10-01");
  });

  it("records an unsaved historical auto quote using the audited endpoint", async () => {
    request
      .mockResolvedValueOnce(reply({ saved: false, source: "fetched", rate: "1.2", effectiveDate: "2026-10-01" }))
      .mockResolvedValueOnce(reply({ created: true, rateToUsd: "1.2" }, 201));
    await ensureDatedAutoFxRate("EUR", "2026-10-01");
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/factory/fx-rates/EUR/2026-10-01");
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/factory/fx-rates/fetched", {
      currencyCode: "EUR",
      date: "2026-10-01",
    });
  });

  it("blocks a save if a suggested auto rate cannot be confirmed", async () => {
    request
      .mockResolvedValueOnce(reply({ saved: false, rate: "1.2" }))
      .mockResolvedValueOnce(reply({ message: "Forbidden" }, 403));
    await expect(ensureDatedAutoFxRate("EUR", "2026-10-01")).rejects.toThrow(
      /Admin or Owner must confirm/
    );
  });

  it("does not record a rate as a side effect for USD", async () => {
    await ensureDatedAutoFxRate("USD", "2026-10-01");
    expect(request).not.toHaveBeenCalled();
  });
});
