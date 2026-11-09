import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  erpCompanyDataKey,
  erpDataKeys,
  erpRequestUrl,
  erpUnwrapPage,
  invalidateErpDataFamilies,
} from "./erpData";
import { formatErpFixedQuantity, formatErpMoneyDisplay } from "./erpDisplay";

describe("ERP data and display contract", () => {
  it("keeps the real canonical URL first and separates companies", () => {
    const url = erpRequestUrl("/api/vouchers/optional", { search: "abc", type: "Sales", startDate: "" });
    expect(url).toBe("/api/vouchers/optional?search=abc&type=Sales");
    expect(erpCompanyDataKey(url, 11)).toEqual([url, 11]);
    expect(erpCompanyDataKey(url, 12)).toEqual([url, 12]);
    expect(erpDataKeys.scoped("/api/accounts/all", 11)).toEqual(["/api/accounts/all", 11]);
  });

  it("invalidates both old and company-scoped filtered queries", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const oldKey = ["/api/vouchers/optional", "Sales"];
    const scopedKey = ["/api/vouchers/optional?type=Sales", 11];
    const unrelated = ["/api/vouchers-archive", 11];
    client.setQueryData(oldKey, []);
    client.setQueryData(scopedKey, []);
    client.setQueryData(unrelated, []);

    await invalidateErpDataFamilies(client, ["/api/vouchers/optional", "/api/vouchers/optional"]);
    expect(client.getQueryState(oldKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(scopedKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });

  it("preserves legacy response metadata and doesn't fabricate extra rows", () => {
    expect(erpUnwrapPage({ data: [1, 2], total: 201, page: 2, pageSize: 100 }).totalPages).toBe(3);
  });

  it("preserves fixed stock decimal display and explicitly denominated money", () => {
    expect(formatErpFixedQuantity(250)).toBe("250.00");
    expect(formatErpFixedQuantity(1250.5)).toBe("1,250.50");
    expect(formatErpMoneyDisplay(250, { currency: "USD" })).toContain("250");
  });
});
