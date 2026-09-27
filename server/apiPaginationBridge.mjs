import process from "node:process";

const INSTALL_KEY = Symbol.for("erp.api-pagination-bridge.installed");
const PATCH_KEY = Symbol.for("erp.api-pagination-bridge.patch");

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;

  const DEFAULT_LIMIT = 100;
  const DEFAULT_MAX_LIMIT = 250;
  const maxLimit = readPositiveInt(process.env.API_PAGINATION_MAX_LIMIT, DEFAULT_MAX_LIMIT);
  const defaultLimit = Math.min(readPositiveInt(process.env.API_PAGINATION_DEFAULT_LIMIT, DEFAULT_LIMIT), maxLimit);

  const heavyArrayPaths = new Set([
    "/api/stock-items",
    "/api/inventory",
    "/api/factory/bales",
    "/api/factory/daybook",
    "/api/factory/v5/stock-allocation",
    "/api/vouchers",
    // /api/ledger-accounts intentionally excluded: voucher pickers need the full
    // list for all companies. Compact response profiles are available for picker
    // callers without changing the legacy array contract or applying pagination.
  ]);

  const heavyArrayPathPatterns = [
    /^\/api\/vouchers\/\d+\/(?:entries|view-entries)$/,
    /^\/api\/accounts\/(?:ledger|supplier|customer|employee|bank|asset)\/\d+\/transactions$/,
  ];

  function readPositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function parseRequest(req) {
    try {
      const url = new URL(req?.originalUrl || req?.url || "/", "http://localhost");
      return { pathname: url.pathname, searchParams: url.searchParams };
    } catch {
      return { pathname: req?.path || req?.url || "/", searchParams: new URLSearchParams() };
    }
  }

  function isProtectedPath(pathname) {
    return heavyArrayPaths.has(pathname) || heavyArrayPathPatterns.some((pattern) => pattern.test(pathname));
  }

  function wantsPagination(searchParams) {
    return (
      searchParams.get("pagination") === "1" ||
      searchParams.has("page") ||
      searchParams.has("limit") ||
      searchParams.has("pageSize") ||
      searchParams.has("offset")
    );
  }

  function parsePagination(searchParams) {
    const requestedLimit = searchParams.get("limit") ?? searchParams.get("pageSize");
    const limit = Math.min(readPositiveInt(requestedLimit, defaultLimit), maxLimit);

    const offsetValue = searchParams.get("offset");
    if (offsetValue !== null) {
      const offset = Math.max(0, Number.parseInt(offsetValue, 10) || 0);
      return { page: Math.floor(offset / limit) + 1, limit, offset };
    }

    const page = readPositiveInt(searchParams.get("page"), 1);
    return { page, limit, offset: (page - 1) * limit };
  }

  function setPaginationHeaders(res, total, page, limit, totalPages, defaultApplied) {
    if (res.headersSent) return;
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("X-Page", String(page));
    res.setHeader("X-Page-Size", String(limit));
    res.setHeader("X-Total-Pages", String(totalPages));
    res.setHeader("X-Default-Limit-Applied", defaultApplied ? "true" : "false");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages, X-Default-Limit-Applied"
    );
  }

  function compactOtwContainerSummary(body) {
    return body
      .filter((container) => container?.status === "OTW")
      .map((container) => ({
        id: container.id,
        status: container.status,
        grandTotal: container.grandTotal,
      }));
  }

  function compactStockOtwItems(body) {
    const grouped = new Map();

    for (const row of body) {
      const key = JSON.stringify([
        row?.stockItemName || "",
        row?.containerNumber || "",
        row?.supplierName || "",
        row?.gradeName || "",
        row?.categoryName || "",
      ]);
      const quantity = Number(row?.quantity || 0);
      const totalCost = Number(row?.totalCost || 0);
      const existing = grouped.get(key);

      if (existing) {
        existing.quantity += Number.isFinite(quantity) ? quantity : 0;
        existing.totalCost += Number.isFinite(totalCost) ? totalCost : 0;
        continue;
      }

      grouped.set(key, {
        stockItemName: row?.stockItemName || "",
        containerNumber: row?.containerNumber || "",
        supplierName: row?.supplierName || "Unknown",
        gradeName: row?.gradeName ?? null,
        categoryName: row?.categoryName ?? null,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        totalCost: Number.isFinite(totalCost) ? totalCost : 0,
      });
    }

    return [...grouped.values()].map((row) => ({
      stockItemName: row.stockItemName,
      quantity: String(row.quantity),
      totalCost: String(row.totalCost),
      rate: String(row.quantity === 0 ? 0 : row.totalCost / row.quantity),
      containerNumber: row.containerNumber,
      supplierName: row.supplierName,
      gradeName: row.gradeName,
      categoryName: row.categoryName,
    }));
  }

  function compactStockOtwItemsV2(body) {
    const containers = [];
    const containerIndexes = new Map();
    const items = new Map();

    for (const row of body) {
      const containerNumber = row?.containerNumber || "";
      const supplierName = row?.supplierName || "Unknown";
      const containerKey = JSON.stringify([containerNumber, supplierName]);
      let containerIndex = containerIndexes.get(containerKey);
      if (containerIndex === undefined) {
        containerIndex = containers.length;
        containerIndexes.set(containerKey, containerIndex);
        containers.push([containerNumber, supplierName]);
      }

      const itemName = row?.stockItemName || "";
      let item = items.get(itemName);
      if (!item) {
        item = {
          n: itemName,
          g: row?.gradeName ?? null,
          c: row?.categoryName ?? null,
          r: new Map(),
        };
        items.set(itemName, item);
      } else {
        if (!item.g && row?.gradeName) item.g = row.gradeName;
        if (!item.c && row?.categoryName) item.c = row.categoryName;
      }

      const quantity = Number(row?.quantity || 0);
      const totalCost = Number(row?.totalCost || 0);
      const existing = item.r.get(containerIndex);
      if (existing) {
        existing[1] += Number.isFinite(quantity) ? quantity : 0;
        existing[2] += Number.isFinite(totalCost) ? totalCost : 0;
      } else {
        item.r.set(containerIndex, [
          containerIndex,
          Number.isFinite(quantity) ? quantity : 0,
          Number.isFinite(totalCost) ? totalCost : 0,
        ]);
      }
    }

    return {
      c: containers,
      i: [...items.values()]
        .sort((left, right) => left.n.localeCompare(right.n))
        .map((item) => ({
          n: item.n,
          g: item.g,
          c: item.c,
          r: [...item.r.values()].sort((left, right) => left[0] - right[0]),
        })),
    };
  }

  function compactCombinedContainerDetail(body) {
    const pos = Array.isArray(body?.pos)
      ? body.pos.map((po) => ({
          items: Array.isArray(po?.items)
            ? po.items.map((item) => ({
                stockItemId: item?.stockItemId ?? null,
                stockItemName: item?.stockItemName || item?.itemName || "",
                itemName: item?.itemName || item?.stockItemName || "",
                stockGroupId: item?.stockGroupId ?? null,
                stockGroupName: item?.stockGroupName || "",
                quantity: item?.quantity || "0",
                rate: item?.rate || "0",
              }))
            : [],
        }))
      : [];

    return { pos };
  }

  function compactWorkerBaleSummary(body) {
    return body.map((bale) => ({
      id: bale?.id,
      baleCode: bale?.baleCode,
      productName: bale?.productName ?? null,
      weightKg: bale?.weightKg,
      totalCost: bale?.totalCost,
      status: bale?.status,
      finalizedAt: bale?.finalizedAt ?? null,
    }));
  }

  function compactLedgerPicker(body) {
    return body.map((account) => ({
      id: account?.id,
      code: account?.code,
      name: account?.name,
      accountType: account?.accountType,
      subType: account?.subType ?? null,
      parentId: account?.parentId ?? null,
      active: account?.active !== false,
      isHidden: account?.isHidden === true,
    }));
  }

  function compactLocationInventoryView(body) {
    return body.map((item) => ({
      inventoryId: item?.inventoryId ?? null,
      locationId: item?.locationId,
      stockItemId: item?.stockItemId,
      quantity: item?.quantity,
      averageRate: item?.averageRate,
      totalValue: item?.totalValue,
      stockItemCode: item?.stockItemCode ?? "",
      stockItemName: item?.stockItemName ?? "",
      stockItemUom: item?.stockItemUom ?? "",
      stockGroupId: item?.stockGroupId ?? null,
      stockGroupName: item?.stockGroupName ?? null,
      stockGroupCode: item?.stockGroupCode ?? null,
      stockItemActive: item?.stockItemActive ?? null,
      categoryId: item?.categoryId ?? null,
      categoryName: item?.categoryName ?? null,
    }));
  }

  function compactAnalyticsAccounts(body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.accounts)) return body;

    const accounts = body.accounts
      .filter((account) => account?.type === "ledger" || account?.type === "bank" || account?.type === "fixedAsset")
      .map((account) => ({
        id: account?.id,
        accountId: account?.accountId,
        type: account?.type,
        code: account?.code ?? "",
        name: account?.name ?? "",
        accountType: account?.accountType ?? null,
        subType: account?.subType ?? null,
        balance: account?.balance ?? "0",
        balanceSide: account?.balanceSide ?? null,
        parentId: account?.parentId ?? null,
      }));

    return { accounts, asOfDate: body.asOfDate };
  }

  function applyResponseProfile(pathname, searchParams, body) {
    const profile = searchParams.get("profile");
    if (!profile) return body;

    if (pathname === "/api/containers" && profile === "otw-summary" && Array.isArray(body)) {
      return compactOtwContainerSummary(body);
    }

    if (pathname === "/api/containers/otw-items" && profile === "stock-otw" && Array.isArray(body)) {
      return compactStockOtwItems(body);
    }

    if (pathname === "/api/containers/otw-items" && profile === "stock-otw-v2" && Array.isArray(body)) {
      return compactStockOtwItemsV2(body);
    }

    if (
      /^\/api\/containers\/\d+$/.test(pathname) &&
      profile === "combined-detail" &&
      body &&
      typeof body === "object"
    ) {
      return compactCombinedContainerDetail(body);
    }

    if (
      /^\/api\/factory\/workers\/\d+\/bales$/.test(pathname) &&
      profile === "worker-bales-summary" &&
      Array.isArray(body)
    ) {
      return compactWorkerBaleSummary(body);
    }

    if (pathname === "/api/ledger-accounts" && profile === "picker" && Array.isArray(body)) {
      return compactLedgerPicker(body);
    }

    if (/^\/api\/locations\/\d+\/inventory$/.test(pathname) && profile === "view" && Array.isArray(body)) {
      return compactLocationInventoryView(body);
    }

    if (pathname === "/api/accounts/all" && profile === "analytics") {
      return compactAnalyticsAccounts(body);
    }

    return body;
  }

  const expressNamespace = await import("express");
  const expressModule = expressNamespace.default || expressNamespace;
  const responsePrototype = expressModule.response || expressNamespace.response;

  if (responsePrototype?.json && !responsePrototype.json[PATCH_KEY]) {
    const originalJson = responsePrototype.json;

    const paginatedJson = function paginatedHeavyArrayJson(body) {
      const req = this.req;
      if (req?.method !== "GET") return originalJson.call(this, body);

      const { pathname, searchParams } = parseRequest(req);
      const profiledBody = applyResponseProfile(pathname, searchParams, body);
      if (!Array.isArray(profiledBody) || !isProtectedPath(pathname)) {
        return originalJson.call(this, profiledBody);
      }

      const total = profiledBody.length;

      // Preserve the legacy array response shape while enforcing a safe default
      // upper bound for callers that have not opted into structured pagination.
      if (!wantsPagination(searchParams)) {
        const limit = defaultLimit;
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
        setPaginationHeaders(this, total, 1, limit, totalPages, true);
        return originalJson.call(this, profiledBody.slice(0, limit));
      }

      const { page, limit, offset } = parsePagination(searchParams);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const items = profiledBody.slice(offset, offset + limit);

      setPaginationHeaders(this, total, page, limit, totalPages, false);
      return originalJson.call(this, {
        items,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      });
    };

    Object.defineProperty(paginatedJson, PATCH_KEY, { value: true });
    responsePrototype.json = paginatedJson;
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message: "Heavy API pagination and payload profiles enabled",
      module: "api-pagination-bridge",
      defaultLimit,
      maxLimit,
      protectedPaths: [...heavyArrayPaths],
      protectedPathPatterns: heavyArrayPathPatterns.map((pattern) => pattern.source),
      responseProfiles: [
        "otw-summary",
        "stock-otw",
        "stock-otw-v2",
        "combined-detail",
        "worker-bales-summary",
        "picker",
        "view",
        "analytics",
      ],
    })
  );
}
