import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}
function write(path, content) {
  fs.writeFileSync(path, content);
}
function mustReplace(path, before, after, label) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor in ${path}, found ${count}`);
  write(path, source.replace(before, after));
}
function mustReplaceAll(path, before, after, expected, label) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} anchors in ${path}, found ${count}`);
  write(path, source.split(before).join(after));
}

// ---------------------------------------------------------------------------
// 1) Shared browser capacity contract / progress mapping.
// ---------------------------------------------------------------------------
write(
  "client/src/lib/proformaCapacity.ts",
  `export type ProformaLineStatus = "fulfilled" | "overloaded" | "short" | "none";\n\nexport interface ProformaCapacityArticle {\n  articleCode: string;\n  normalizedArticleCode: string;\n  isOnProforma: boolean;\n  requestedQty: number;\n  currentOrderLoadedQty: number;\n  siblingLoadedQty: number;\n  totalConsumedQty: number;\n  remainingQty: number;\n  excessQty: number;\n  isFulfilled: boolean;\n  isOverloaded: boolean;\n  productName?: string;\n}\n\nexport interface ProformaCapacitySnapshot {\n  proformaId: number;\n  companyId: number;\n  customerId: number;\n  proformaName: string;\n  proformaActive: boolean;\n  currentOrderId: number | null;\n  requestedTotalQty: number;\n  currentOrderLoadedTotalQty: number;\n  siblingLoadedTotalQty: number;\n  totalConsumedQty: number;\n  remainingTotalQty: number;\n  excessTotalQty: number;\n  articles: ProformaCapacityArticle[];\n}\n\nexport interface ProformaProgressLine {\n  id: string;\n  articleCode: string;\n  normalizedArticleCode: string;\n  productName: string;\n  quantity: number;\n  loaded: number;\n  siblingLoaded: number;\n  totalLoaded: number;\n  remaining: number;\n  fulfilled: boolean;\n  status: ProformaLineStatus;\n  excess: number;\n}\n\nexport function normalizeProformaArticleCode(value: unknown): string {\n  return String(value ?? "").trim().toLowerCase();\n}\n\nexport function buildProformaProgress(snapshot: ProformaCapacitySnapshot | null | undefined): ProformaProgressLine[] {\n  if (!snapshot) return [];\n  return snapshot.articles\n    .filter((article) => article.isOnProforma)\n    .map((article) => {\n      const status: ProformaLineStatus = article.isOverloaded\n        ? "overloaded"\n        : article.requestedQty > 0 && article.totalConsumedQty === article.requestedQty\n          ? "fulfilled"\n          : article.totalConsumedQty === 0\n            ? "none"\n            : "short";\n      return {\n        id: \`\${snapshot.proformaId}:\${article.normalizedArticleCode}\`,\n        articleCode: article.articleCode,\n        normalizedArticleCode: article.normalizedArticleCode,\n        productName: article.productName || article.articleCode,\n        quantity: article.requestedQty,\n        loaded: article.currentOrderLoadedQty,\n        siblingLoaded: article.siblingLoadedQty,\n        totalLoaded: article.totalConsumedQty,\n        remaining: article.remainingQty,\n        fulfilled: article.isFulfilled,\n        status,\n        excess: article.excessQty,\n      };\n    });\n}\n`
);

write(
  "client/src/lib/proformaCapacity.test.ts",
  `import { describe, expect, it } from "vitest";\nimport { buildProformaProgress, type ProformaCapacitySnapshot } from "./proformaCapacity";\n\nfunction snapshot(overrides: Partial<ProformaCapacitySnapshot> = {}): ProformaCapacitySnapshot {\n  return {\n    proformaId: 71,\n    companyId: 12,\n    customerId: 23,\n    proformaName: "Test",\n    proformaActive: true,\n    currentOrderId: 170,\n    requestedTotalQty: 42,\n    currentOrderLoadedTotalQty: 5,\n    siblingLoadedTotalQty: 10,\n    totalConsumedQty: 15,\n    remainingTotalQty: 27,\n    excessTotalQty: 0,\n    articles: [\n      {\n        articleCode: "HMD12630",\n        normalizedArticleCode: "hmd12630",\n        isOnProforma: true,\n        requestedQty: 42,\n        currentOrderLoadedQty: 5,\n        siblingLoadedQty: 10,\n        totalConsumedQty: 15,\n        remainingQty: 27,\n        excessQty: 0,\n        isFulfilled: false,\n        isOverloaded: false,\n        productName: "Product A",\n      },\n    ],\n    ...overrides,\n  };\n}\n\ndescribe("buildProformaProgress", () => {\n  it("uses authoritative global consumption without subtracting the current loading twice", () => {\n    expect(buildProformaProgress(snapshot())).toEqual([\n      expect.objectContaining({\n        quantity: 42,\n        loaded: 5,\n        siblingLoaded: 10,\n        totalLoaded: 15,\n        remaining: 27,\n        status: "short",\n      }),\n    ]);\n  });\n\n  it("preserves historical overload while flooring remaining quantity at zero", () => {\n    const value = snapshot({\n      remainingTotalQty: 0,\n      excessTotalQty: 65,\n      articles: [\n        {\n          articleCode: "A",\n          normalizedArticleCode: "a",\n          isOnProforma: true,\n          requestedQty: 42,\n          currentOrderLoadedQty: 5,\n          siblingLoadedQty: 102,\n          totalConsumedQty: 107,\n          remainingQty: 0,\n          excessQty: 65,\n          isFulfilled: true,\n          isOverloaded: true,\n        },\n      ],\n    });\n    expect(buildProformaProgress(value)[0]).toEqual(expect.objectContaining({ status: "overloaded", remaining: 0, excess: 65 }));\n  });\n});\n`
);

// ---------------------------------------------------------------------------
// 2) Server read contract: expose the authoritative Phase 1 snapshot directly.
// ---------------------------------------------------------------------------
const proformasPath = "server/routes/factory/customer-proformas/proformas.ts";
mustReplace(
  proformasPath,
  `  customerProformas,\n  customers,\n  insertCustomerProformaSchema,`,
  `  customerProformas,\n  customerProformaLines,\n  customers,\n  insertCustomerProformaSchema,`,
  "proforma line import"
);
mustReplace(
  proformasPath,
  `import { eq, and, sql, inArray } from "drizzle-orm";\n`,
  `import { eq, and, sql, inArray } from "drizzle-orm";\nimport { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";\nimport { normalizeLoadingArticleCode } from "../customer-orders/bale-scanning/proformaScanPolicy";\n`,
  "capacity imports"
);
mustReplace(
  proformasPath,
  `export function registerFactoryCustomerProformaCrudRoutes(app: Express) {\n  /* Single proforma by ID — used by EditProformaV5Drawer and lazy detail readers. */`,
  `export function registerFactoryCustomerProformaCrudRoutes(app: Express) {\n  // Authoritative capacity read contract. Keep the summary list compact; screens\n  // that need live progress fetch this one snapshot instead of re-deriving it.\n  app.get("/api/factory/customer-proformas/:id/capacity", requireAuth, async (req: Request, res: Response) => {\n    try {\n      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;\n      if (!companyId) return res.status(400).json({ message: "No company selected" });\n      const proformaId = parseId(req.params.id);\n      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });\n      const currentOrderId = parseOptionalId(req.query.currentOrderId);\n      if (req.query.currentOrderId !== undefined && req.query.currentOrderId !== "" && currentOrderId === null) {\n        return res.status(400).json({ message: "Invalid currentOrderId" });\n      }\n\n      const snapshot = await getProformaCapacitySnapshot(db, { companyId, proformaId, currentOrderId });\n      if (!snapshot) return res.status(404).json({ message: "Proforma not found" });\n\n      const sourceLines = await db\n        .select({ articleCode: customerProformaLines.articleCode, productName: customerProformaLines.productName })\n        .from(customerProformaLines)\n        .where(eq(customerProformaLines.proformaId, proformaId));\n      const productNames = new Map<string, string>();\n      for (const line of sourceLines) {\n        const normalized = normalizeLoadingArticleCode(line.articleCode);\n        const name = String(line.productName || "").trim();\n        if (normalized && name && !productNames.has(normalized)) productNames.set(normalized, name);\n      }\n\n      res.set("Cache-Control", "private, no-store");\n      return res.json({\n        ...snapshot,\n        articles: snapshot.articles.map((article) => ({\n          ...article,\n          productName: productNames.get(article.normalizedArticleCode) || article.articleCode,\n        })),\n      });\n    } catch (error: unknown) {\n      res.status(500).json({ message: getErrorMessage(error) });\n    }\n  });\n\n  /* Single proforma by ID — used by EditProformaV5Drawer and lazy detail readers. */`,
  "capacity endpoint"
);

// ---------------------------------------------------------------------------
// 3) Reservation cache: derive from the exact same Phase 1 snapshot.
// ---------------------------------------------------------------------------
write(
  "server/routes/factory/_stockReservationHelper.ts",
  `import { sql, and, eq } from "drizzle-orm";\nimport { db } from "../../db";\nimport { proformaStockReservations, companies } from "@shared/schema";\nimport { firstRow } from "../../lib/queryResult";\nimport { getProformaCapacitySnapshot } from "./customer-orders/proformaCapacity";\nimport { normalizeLoadingArticleCode } from "./customer-orders/bale-scanning/proformaScanPolicy";\n\ntype DbOrTx = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;\n\n/**\n * Rebuild the derived reservation cache from the authoritative capacity engine.\n * reservedQty is exactly the per-article remaining commitment after every\n * non-cancelled, non-deleted linked order, including verified/finalized history.\n */\nexport async function syncProformaReservations(tx: DbOrTx, companyId: number, proformaId: number): Promise<void> {\n  const snapshot = await getProformaCapacitySnapshot(tx, { companyId, proformaId });\n  if (!snapshot || !snapshot.proformaActive) {\n    await tx\n      .delete(proformaStockReservations)\n      .where(and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, proformaId)));\n    return;\n  }\n\n  const desiredRows = snapshot.articles\n    .filter((article) => article.isOnProforma && article.normalizedArticleCode)\n    .map((article) => ({\n      companyId,\n      proformaId,\n      articleCode: article.articleCode.trim() || article.normalizedArticleCode,\n      reservedQty: article.remainingQty,\n    }));\n\n  if (desiredRows.length === 0) {\n    await tx\n      .delete(proformaStockReservations)\n      .where(and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, proformaId)));\n    return;\n  }\n\n  await tx\n    .insert(proformaStockReservations)\n    .values(desiredRows)\n    .onConflictDoUpdate({\n      target: [\n        proformaStockReservations.companyId,\n        proformaStockReservations.proformaId,\n        proformaStockReservations.articleCode,\n      ],\n      set: { reservedQty: sql\`excluded.reserved_qty\` },\n    });\n\n  const keepCodes = desiredRows.map((row) => row.articleCode);\n  const keepList = sql.join(keepCodes.map((code) => sql\`\${code}\`), sql\`, \`);\n  await tx.execute(sql\`DELETE FROM proforma_stock_reservations\n      WHERE company_id = \${companyId}\n        AND proforma_id = \${proformaId}\n        AND article_code NOT IN (\${keepList})\`);\n}\n\nexport async function isFactoryV2Company(companyId: number): Promise<boolean> {\n  const [co] = await db\n    .select({ companyType: companies.companyType })\n    .from(companies)\n    .where(eq(companies.id, companyId));\n  return co?.companyType === "factory" || co?.companyType === "factory_v2";\n}\n\n/**\n * Current free-to-promise stock for one normalized article bucket. Reconcile\n * matching active proformas first so stale historical cache rows cannot block\n * or inflate a new promise.\n */\nexport async function computeFreeToPromise(companyId: number, articleCode: string): Promise<number> {\n  const normalized = normalizeLoadingArticleCode(articleCode);\n  if (!normalized) return 0;\n\n  const matchingProformas = await db.execute(sql\`SELECT DISTINCT cp.id\n      FROM customer_proformas cp\n      JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id\n      WHERE cp.company_id = \${companyId}\n        AND cp.deleted_at IS NULL\n        AND cp.is_active = true\n        AND LOWER(TRIM(cpl.article_code)) = \${normalized}\`);\n  for (const row of matchingProformas.rows) {\n    const proformaId = Number(row.id);\n    if (Number.isSafeInteger(proformaId) && proformaId > 0) {\n      await syncProformaReservations(db, companyId, proformaId);\n    }\n  }\n\n  const inStockRow = firstRow<{ count: number | null }>(\n    await db.execute(sql\`SELECT COUNT(*)::int AS count\n        FROM factory_bales\n        WHERE company_id = \${companyId}\n          AND LOWER(TRIM(article_code)) = \${normalized}\n          AND status = 'IN_STOCK'\`)\n  );\n  const inStock = Number(inStockRow?.count ?? 0);\n\n  const reservedRow = firstRow<{ total: number | null }>(\n    await db.execute(sql\`SELECT COALESCE(SUM(reserved_qty),0)::int AS total\n        FROM proforma_stock_reservations\n        WHERE company_id = \${companyId}\n          AND LOWER(TRIM(article_code)) = \${normalized}\`)\n  );\n  const reservedNotYetLoaded = Number(reservedRow?.total ?? 0);\n  return Math.max(0, inStock - reservedNotYetLoaded);\n}\n`
);

// ---------------------------------------------------------------------------
// 4) Stock allocation: reservation rows are already net of loaded consumption.
// ---------------------------------------------------------------------------
const allocationPath = "server/routes/factory/factoryStockAllocationV2Routes.ts";
mustReplace(
  allocationPath,
  `    // proformaReserved = total proforma commitment = what's still owed + what's already in loading\n    const proformaReserved = reservedNotYetLoaded + inLoading;\n    // In-loading bales count toward satisfying reservations (even if the loading order\n    // isn't formally linked to a proforma). Net pending = max(0, owed − inLoading).\n    // freeToPromise = free stock minus the net pending reservations (floor 0).\n    const netPendingReservation = Math.max(0, reservedNotYetLoaded - inLoading);\n    const freeToPromise = Math.max(0, inStock - netPendingReservation);`,
  `    // reservedNotYetLoaded is already net of every linked order contribution.\n    // Do not subtract inLoading a second time; that made free stock look larger\n    // than it really was whenever a loading was in progress.\n    const proformaReserved = reservedNotYetLoaded + inLoading;\n    const freeToPromise = Math.max(0, inStock - reservedNotYetLoaded);`,
  "stock allocation double subtraction"
);

// ---------------------------------------------------------------------------
// 5) Factory loading model: capacity endpoint drives progress and stock targets.
// ---------------------------------------------------------------------------
const factoryModel = "client/src/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel.ts";
mustReplace(
  factoryModel,
  `import { getErrorDetails } from "@shared/errorUtils";\n`,
  `import { getErrorDetails } from "@shared/errorUtils";\nimport {\n  buildProformaProgress,\n  normalizeProformaArticleCode,\n  type ProformaCapacitySnapshot,\n} from "@/lib/proformaCapacity";\n`,
  "factory capacity import"
);
mustReplace(
  factoryModel,
  `  const { data: baleRemovals = [] } = useQuery<BaleRemoval[]>({`,
  `  const selectedCapacityProformaId =\n    selectedProformaId && selectedProformaId !== "none" ? Number(selectedProformaId) : null;\n  const capacityProformaId = orderDetail?.proformaIdUsed ?? selectedCapacityProformaId;\n  const capacityQuery = useQuery<ProformaCapacitySnapshot>({\n    queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId, orderId],\n    queryFn: async () => {\n      const params = new URLSearchParams();\n      if (orderId) params.set("currentOrderId", String(orderId));\n      const suffix = params.size ? \`?\${params.toString()}\` : "";\n      const res = await fetch(\`/api/factory/customer-proformas/\${capacityProformaId}/capacity\${suffix}\`, {\n        credentials: "include",\n      });\n      if (!res.ok) throw new Error("Failed to fetch proforma capacity");\n      return res.json();\n    },\n    enabled: !!capacityProformaId,\n    staleTime: 0,\n  });\n  const proformaCapacity = capacityQuery.data ?? null;\n  const selectedProformaExhausted =\n    !!selectedCapacityProformaId &&\n    proformaCapacity?.proformaId === selectedCapacityProformaId &&\n    proformaCapacity.remainingTotalQty <= 0;\n\n  const { data: baleRemovals = [] } = useQuery<BaleRemoval[]>({`,
  "factory capacity query"
);
mustReplaceAll(
  factoryModel,
  `      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);`,
  `      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);\n      if (capacityProformaId) {\n        void queryClient.invalidateQueries({\n          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],\n          refetchType: "active",\n        });\n      }`,
  1,
  "factory scan capacity refresh"
);
mustReplace(
  factoryModel,
  `      queryClient.invalidateQueries({\n        queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],\n      });\n      setBaleToDelete(null);`,
  `      queryClient.invalidateQueries({\n        queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],\n      });\n      if (capacityProformaId) {\n        void queryClient.invalidateQueries({\n          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],\n          refetchType: "active",\n        });\n      }\n      setBaleToDelete(null);`,
  "factory remove refresh"
);
mustReplace(
  factoryModel,
  `      setShowImportDialog(false);\n      setImportPreview([]);`,
  `      if (capacityProformaId) {\n        void queryClient.invalidateQueries({\n          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],\n          refetchType: "active",\n        });\n      }\n      setShowImportDialog(false);\n      setImportPreview([]);`,
  "factory bulk refresh"
);
mustReplace(
  factoryModel,
  `    const proforma = chosenProforma();\n\n    // Check if there are already pending loading orders for this proforma`,
  `    const proforma = chosenProforma();\n    if (\n      proforma &&\n      proformaCapacity?.proformaId === proforma.id &&\n      proformaCapacity.remainingTotalQty <= 0\n    ) {\n      toast({ title: "Proforma fully consumed", description: "No remaining quantity is available for a new loading." });\n      return;\n    }\n\n    // Check if there are already pending loading orders for this proforma`,
  "factory exhausted guard"
);
mustReplace(
  factoryModel,
  `  }, [customerId, selectedLocationId, chosenProforma, orderDate, loadingNote, createOrderMutation]);`,
  `  }, [\n    customerId,\n    selectedLocationId,\n    chosenProforma,\n    proformaCapacity,\n    orderDate,\n    loadingNote,\n    createOrderMutation,\n    toast,\n  ]);`,
  "factory start dependencies"
);
mustReplace(
  factoryModel,
  `  // Stock count query — fetches IN_STOCK bale counts per article code for proforma lines\n  const proformaArticleCodesForStock = useMemo(() => {\n    if (!orderDetail?.proformaIdUsed) return [];\n    const pf = proformas.find((p) => p.id === orderDetail.proformaIdUsed) || proformas.find((p) => p.isActive);\n    return (Array.isArray(pf?.lines) ? pf!.lines : []).map((l) => l.articleCode).filter(Boolean);\n  }, [orderDetail?.proformaIdUsed, proformas]);`,
  `  // Stock count targets come from the same authoritative capacity buckets.\n  const proformaArticleCodesForStock = useMemo(\n    () =>\n      proformaCapacity?.articles\n        .filter((article) => article.isOnProforma)\n        .map((article) => article.articleCode)\n        .filter(Boolean) ?? [],\n    [proformaCapacity]\n  );`,
  "factory stock target source"
);
mustReplace(
  factoryModel,
  `  // Linked proforma logic\n  const linkedProforma = orderDetail?.proformaIdUsed\n    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed)\n    : proformas.find((p) => p.isActive) || null;\n  const effectiveProformaLines = orderDetail?.proformaRemainingLines ?? linkedProforma?.lines ?? [];\n\n  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {\n    const key = b.articleCode ?? "__unknown__";\n    map[key] = (map[key] || 0) + 1;\n    return map;\n  }, {});\n\n  const proformaProgress =\n    effectiveProformaLines.map((line) => {\n      const loaded = loadedByArticle[line.articleCode] || 0;\n      const remaining = line.quantity - loaded;\n      const status: ProformaLineStatus =\n        loaded === 0\n          ? "none"\n          : loaded > line.quantity\n            ? "overloaded"\n            : loaded === line.quantity\n              ? "fulfilled"\n              : "short";\n      return {\n        ...line,\n        loaded,\n        remaining,\n        fulfilled: loaded >= line.quantity,\n        status,\n        excess: Math.max(0, loaded - line.quantity),\n      };\n    }) || [];\n\n  const fulfilledCount = proformaProgress.filter((l) => l.status === "fulfilled" || l.status === "overloaded").length;\n  const totalLines = proformaProgress.length;\n\n  // Extra bales not in proforma\n  const proformaArticleCodes = new Set(effectiveProformaLines.map((l) => l.articleCode));\n  const remainingProformaBales = proformaProgress.reduce((sum, line) => sum + Math.max(0, line.remaining), 0);\n  const extraArticles = Object.keys(loadedByArticle).filter((code) => !proformaArticleCodes.has(code));`,
  `  // Linked proforma metadata stays compact; all quantity math comes from the\n  // authoritative capacity snapshot so sibling loadings are never missed.\n  const linkedProforma = orderDetail?.proformaIdUsed\n    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed) ||\n      (proformaCapacity\n        ? {\n            id: proformaCapacity.proformaId,\n            customerId: proformaCapacity.customerId,\n            name: proformaCapacity.proformaName,\n            isActive: proformaCapacity.proformaActive,\n            lines: [],\n          }\n        : null)\n    : proformas.find((p) => p.isActive) || null;\n\n  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {\n    const key = b.articleCode ?? "__unknown__";\n    map[key] = (map[key] || 0) + 1;\n    return map;\n  }, {});\n\n  const proformaProgress = buildProformaProgress(proformaCapacity);\n  const fulfilledCount = proformaProgress.filter((line) => line.status === "fulfilled" || line.status === "overloaded").length;\n  const totalLines = proformaProgress.length;\n\n  const proformaArticleCodes = new Set(\n    proformaCapacity?.articles.filter((article) => article.isOnProforma).map((article) => article.normalizedArticleCode) ?? []\n  );\n  const remainingProformaBales = proformaCapacity?.remainingTotalQty ?? 0;\n  const extraArticles = Object.keys(loadedByArticle).filter(\n    (code) => !proformaArticleCodes.has(normalizeProformaArticleCode(code))\n  );`,
  "factory authoritative progress"
);
mustReplace(
  factoryModel,
  `    activeProformas,\n    selectedProformaId,`,
  `    activeProformas,\n    selectedProformaId,\n    proformaCapacity,\n    isProformaCapacityLoading: capacityQuery.isLoading || capacityQuery.isFetching,\n    selectedProformaExhausted,`,
  "factory return capacity"
);

// ---------------------------------------------------------------------------
// 6) ERP loading model gets the identical capacity contract.
// ---------------------------------------------------------------------------
const erpModel = "client/src/pages/containerloadingscan/useContainerLoadingScanModel.ts";
mustReplace(
  erpModel,
  `import type { Customer, Location, OrderBale, OrderDetail, Proforma } from "./types";\n`,
  `import type { Customer, Location, OrderBale, OrderDetail, Proforma } from "./types";\nimport {\n  buildProformaProgress,\n  normalizeProformaArticleCode,\n  type ProformaCapacitySnapshot,\n} from "@/lib/proformaCapacity";\n`,
  "erp capacity import"
);
mustReplace(
  erpModel,
  `  const { data: orderDetail } = useQuery<OrderDetail>({`,
  `  const activeProforma = proformas.find((p) => p.isActive) || null;\n\n  const { data: orderDetail } = useQuery<OrderDetail>({`,
  "erp active proforma placement"
);
mustReplace(
  erpModel,
  `  // Auto-select location when there is only one option`,
  `  const capacityProformaId = orderDetail?.proformaIdUsed ?? activeProforma?.id ?? null;\n  const capacityQuery = useQuery<ProformaCapacitySnapshot>({\n    queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId, orderId],\n    queryFn: async () => {\n      const params = new URLSearchParams();\n      if (orderId) params.set("currentOrderId", String(orderId));\n      const suffix = params.size ? \`?\${params.toString()}\` : "";\n      const res = await fetch(\`/api/factory/customer-proformas/\${capacityProformaId}/capacity\${suffix}\`, {\n        credentials: "include",\n      });\n      if (!res.ok) throw new Error("Failed to fetch proforma capacity");\n      return res.json();\n    },\n    enabled: !!capacityProformaId,\n    staleTime: 0,\n  });\n  const proformaCapacity = capacityQuery.data ?? null;\n  const activeProformaExhausted =\n    !!activeProforma &&\n    proformaCapacity?.proformaId === activeProforma.id &&\n    proformaCapacity.remainingTotalQty <= 0;\n\n  // Auto-select location when there is only one option`,
  "erp capacity query"
);
mustReplace(
  erpModel,
  `      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);\n      setScanCode("");`,
  `      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);\n      if (capacityProformaId) {\n        void queryClient.invalidateQueries({\n          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],\n          refetchType: "active",\n        });\n      }\n      setScanCode("");`,
  "erp scan refresh"
);
mustReplace(
  erpModel,
  `      toast({ title: "Bale removed" });`,
  `      if (capacityProformaId) {\n        void queryClient.invalidateQueries({\n          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],\n          refetchType: "active",\n        });\n      }\n      toast({ title: "Bale removed" });`,
  "erp remove refresh"
);
mustReplace(
  erpModel,
  `    const activeProforma = proformas.find((p) => p.isActive) || null;\n    createOrderMutation.mutate({`,
  `    if (\n      activeProforma &&\n      proformaCapacity?.proformaId === activeProforma.id &&\n      proformaCapacity.remainingTotalQty <= 0\n    ) {\n      toast({ title: "Proforma fully consumed", description: "No remaining quantity is available for a new loading." });\n      return;\n    }\n    createOrderMutation.mutate({`,
  "erp exhausted guard"
);
mustReplace(
  erpModel,
  `  }, [customerId, selectedLocationId, proformas, orderDate, loadingNote, createOrderMutation]);`,
  `  }, [\n    customerId,\n    selectedLocationId,\n    activeProforma,\n    proformaCapacity,\n    orderDate,\n    loadingNote,\n    createOrderMutation,\n    toast,\n  ]);`,
  "erp start dependencies"
);
mustReplace(
  erpModel,
  `  // Linked proforma logic\n  const linkedProforma = orderDetail?.proformaIdUsed\n    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed)\n    : proformas.find((p) => p.isActive) || null;\n\n  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {\n    map[b.articleCode] = (map[b.articleCode] || 0) + 1;\n    return map;\n  }, {});\n\n  const proformaProgress =\n    linkedProforma?.lines.map((line) => {\n      const loaded = loadedByArticle[line.articleCode] || 0;\n      const remaining = line.quantity - loaded;\n      const status: ProformaLineStatus =\n        loaded === 0\n          ? "none"\n          : loaded > line.quantity\n            ? "overloaded"\n            : loaded === line.quantity\n              ? "fulfilled"\n              : "short";\n      return {\n        ...line,\n        loaded,\n        remaining,\n        fulfilled: loaded >= line.quantity,\n        status,\n        excess: Math.max(0, loaded - line.quantity),\n      };\n    }) || [];\n\n  const fulfilledCount = proformaProgress.filter((l) => l.status === "fulfilled" || l.status === "overloaded").length;\n  const totalLines = proformaProgress.length;\n\n  // Extra bales not in proforma\n  const proformaArticleCodes = new Set(linkedProforma?.lines.map((l) => l.articleCode) || []);\n  const extraArticles = Object.keys(loadedByArticle).filter((code) => !proformaArticleCodes.has(code));`,
  `  const linkedProforma = orderDetail?.proformaIdUsed\n    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed) ||\n      (proformaCapacity\n        ? {\n            id: proformaCapacity.proformaId,\n            customerId: proformaCapacity.customerId,\n            name: proformaCapacity.proformaName,\n            isActive: proformaCapacity.proformaActive,\n            lines: [],\n          }\n        : null)\n    : activeProforma;\n\n  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {\n    map[b.articleCode] = (map[b.articleCode] || 0) + 1;\n    return map;\n  }, {});\n\n  const proformaProgress = buildProformaProgress(proformaCapacity);\n  const fulfilledCount = proformaProgress.filter((line) => line.status === "fulfilled" || line.status === "overloaded").length;\n  const totalLines = proformaProgress.length;\n\n  const proformaArticleCodes = new Set(\n    proformaCapacity?.articles.filter((article) => article.isOnProforma).map((article) => article.normalizedArticleCode) ?? []\n  );\n  const extraArticles = Object.keys(loadedByArticle).filter(\n    (code) => !proformaArticleCodes.has(normalizeProformaArticleCode(code))\n  );`,
  "erp authoritative progress"
);
mustReplace(
  erpModel,
  `\n  const activeProforma = proformas.find((p) => p.isActive) || null;\n\n  return {`,
  `\n  return {`,
  "erp duplicate active proforma"
);
mustReplace(
  erpModel,
  `    activeProforma,\n    selectedCustomerId,`,
  `    activeProforma,\n    proformaCapacity,\n    isProformaCapacityLoading: capacityQuery.isLoading || capacityQuery.isFetching,\n    activeProformaExhausted,\n    selectedCustomerId,`,
  "erp return capacity"
);

// ---------------------------------------------------------------------------
// 7) UI: show global loaded amount, with current+sibling split, and block empty
//    containers when the selected active proforma is exhausted.
// ---------------------------------------------------------------------------
mustReplace(
  "client/src/pages/factory/factorycontainerloadingscan/LoadingSetupCard.tsx",
  `        {!orderId && (\n          <Button\n            className="w-full"\n            onClick={model.handleStartLoading}\n            disabled={!customerId || !model.selectedLocationId || model.createOrderMutation.isPending}`,
  `        {!orderId && model.selectedProformaId && model.selectedProformaId !== "none" && model.proformaCapacity && (\n          <p className="text-xs text-muted-foreground" data-testid="text-proforma-capacity">\n            {model.proformaCapacity.remainingTotalQty} / {model.proformaCapacity.requestedTotalQty} remaining across all loadings\n          </p>\n        )}\n\n        {!orderId && (\n          <Button\n            className="w-full"\n            onClick={model.handleStartLoading}\n            disabled={\n              !customerId ||\n              !model.selectedLocationId ||\n              model.createOrderMutation.isPending ||\n              model.isProformaCapacityLoading ||\n              model.selectedProformaExhausted\n            }`,
  "factory setup capacity"
);

mustReplace(
  "client/src/pages/containerloadingscan/LoadingControlsPanel.tsx",
  `      {!orderId && (\n        <Button\n          className="w-full"\n          onClick={model.handleStartLoading}\n          disabled={!customerId || !model.selectedLocationId || model.createOrderMutation.isPending}`,
  `      {!orderId && activeProforma && model.proformaCapacity && (\n        <p className="text-xs text-muted-foreground" data-testid="text-proforma-capacity">\n          {model.proformaCapacity.remainingTotalQty} / {model.proformaCapacity.requestedTotalQty} remaining across all loadings\n        </p>\n      )}\n\n      {!orderId && (\n        <Button\n          className="w-full"\n          onClick={model.handleStartLoading}\n          disabled={\n            !customerId ||\n            !model.selectedLocationId ||\n            model.createOrderMutation.isPending ||\n            model.isProformaCapacityLoading ||\n            model.activeProformaExhausted\n          }`,
  "erp setup capacity"
);

for (const path of [
  "client/src/pages/factory/factorycontainerloadingscan/ProformaProgressPanel.tsx",
  "client/src/pages/factory/factorycontainerloadingscan/FinalizeLoadingDialog.tsx",
  "client/src/pages/containerloadingscan/LoadingControlsPanel.tsx",
  "client/src/pages/containerloadingscan/LoadingScanDialogs.tsx",
]) {
  mustReplaceAll(path, `{line.loaded}`, `{line.totalLoaded}`, path.includes("LoadingControlsPanel") || path.includes("ProformaProgressPanel") ? 1 : 1, `global loaded display ${path}`);
}

mustReplace(
  "client/src/pages/factory/factorycontainerloadingscan/ProformaProgressPanel.tsx",
  `<TableHead className="text-xs text-right">Loaded</TableHead>`,
  `<TableHead className="text-xs text-right">Loaded (This+Other)</TableHead>`,
  "factory loaded heading"
);
mustReplace(
  "client/src/pages/containerloadingscan/LoadingControlsPanel.tsx",
  `<TableHead className="text-xs text-right">Loaded</TableHead>`,
  `<TableHead className="text-xs text-right">Loaded (This+Other)</TableHead>`,
  "erp loaded heading"
);

for (const path of [
  "client/src/pages/factory/factorycontainerloadingscan/ProformaProgressPanel.tsx",
  "client/src/pages/containerloadingscan/LoadingControlsPanel.tsx",
]) {
  mustReplace(
    path,
    `{line.totalLoaded}</span>`,
    `{line.totalLoaded}</span>\n                  <div className="text-[10px] text-muted-foreground">{line.loaded}+{line.siblingLoaded}</div>`,
    `loaded split ${path}`
  );
}

// ---------------------------------------------------------------------------
// 8) Integration regression: derived reservations include finalized history,
//    ignore cancelled/deleted orders, normalize duplicate lines, and FTP does
//    not subtract an in-progress loading twice.
// ---------------------------------------------------------------------------
write(
  "tests/proforma-capacity-phase4-reconciliation.test.ts",
  `import request from "supertest";\nimport { afterAll, beforeAll, describe, expect, it } from "vitest";\nimport { pool } from "../server/db";\nimport { syncProformaReservations } from "../server/routes/factory/_stockReservationHelper";\nimport { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";\n\nconst PREFIX = "phase4cap";\nlet ctx: TestContext;\nlet agent: request.SuperAgentTest;\nlet customerId: number;\nlet proformaId: number;\nlet currentOrderId: number;\n\nasync function addBale(orderId: number, code: string, suffix: string, status = "SOLD") {\n  const bale = await pool.query<{ id: number }>(\n    \`INSERT INTO factory_bales\n       (company_id, bale_code, reference_number, article_code, product_name, weight_kg, cost_per_kg, total_cost, status)\n     VALUES ($1, $2, $2, $3, 'Phase 4 Product', '30.000', '1.00', '30.00', $4)\n     RETURNING id\`,\n    [ctx.companyId, \`\${PREFIX}-\${suffix}\`, code, status]\n  );\n  await pool.query(\n    \`INSERT INTO customer_order_bales\n       (order_id, bale_id, bale_reference, location_id, weight, article_code, price_used)\n     VALUES ($1, $2, $3, $4, '30.000', $5, '10.00')\`,\n    [orderId, bale.rows[0].id, \`\${PREFIX}-\${suffix}\`, ctx.locationId, code]\n  );\n}\n\nbeforeAll(async () => {\n  ctx = await seedTestData(PREFIX);\n  agent = request.agent(ctx.app);\n  await agent.post("/api/auth/login").send({ username: \`\${PREFIX}_testuser\`, password: "testpassword123" });\n  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });\n\n  const customer = await pool.query<{ id: number }>(\n    \`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id\`,\n    [ctx.companyId, \`\${PREFIX}-CUSTOMER\`, "Phase 4 Customer"]\n  );\n  customerId = customer.rows[0].id;\n  const proforma = await pool.query<{ id: number }>(\n    \`INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, $3, true) RETURNING id\`,\n    [ctx.companyId, customerId, "Phase 4 Proforma"]\n  );\n  proformaId = proforma.rows[0].id;\n  await pool.query(\n    \`INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)\n     VALUES ($1, 'PH4-A', 'Phase 4 Product', 3, '10.00'), ($1, ' ph4-a ', 'Phase 4 Product', 2, '10.00')\`,\n    [proformaId]\n  );\n\n  const orders = await pool.query<{ id: number; status: string }>(\n    \`INSERT INTO customer_orders (company_id, customer_id, order_date, proforma_id_used, status, location_id)\n     VALUES ($1,$2,'2026-09-10',$3,'VERIFIED',$4),\n            ($1,$2,'2026-09-10',$3,'LOADING',$4),\n            ($1,$2,'2026-09-10',$3,'CANCELLED',$4)\n     RETURNING id,status\`,\n    [ctx.companyId, customerId, proformaId, ctx.locationId]\n  );\n  const verifiedId = orders.find((row) => row.status === "VERIFIED")!.id;\n  currentOrderId = orders.find((row) => row.status === "LOADING")!.id;\n  const cancelledId = orders.find((row) => row.status === "CANCELLED")!.id;\n  await addBale(verifiedId, "ph4-a", "verified-1");\n  await addBale(verifiedId, "PH4-A", "verified-2");\n  await addBale(verifiedId, " PH4-A ", "verified-3");\n  await addBale(currentOrderId, "PH4-A", "current-1", "IN_STOCK");\n  await addBale(cancelledId, "PH4-A", "cancelled-1", "IN_STOCK");\n}, 120000);\n\nafterAll(async () => {\n  await cleanupTestData(PREFIX);\n  closeTestServer();\n}, 60000);\n\ndescribe("Phase 4 proforma reconciliation", () => {\n  it("exposes requested/current/sibling/total/remaining from the authoritative endpoint", async () => {\n    const response = await agent.get(\`/api/factory/customer-proformas/\${proformaId}/capacity?currentOrderId=\${currentOrderId}\`);\n    expect(response.status).toBe(200);\n    expect(response.headers["cache-control"]).toContain("no-store");\n    expect(response.body).toEqual(\n      expect.objectContaining({\n        proformaId,\n        requestedTotalQty: 5,\n        currentOrderLoadedTotalQty: 1,\n        siblingLoadedTotalQty: 3,\n        totalConsumedQty: 4,\n        remainingTotalQty: 1,\n      })\n    );\n    expect(response.body.articles).toEqual([\n      expect.objectContaining({\n        normalizedArticleCode: "ph4-a",\n        requestedQty: 5,\n        currentOrderLoadedQty: 1,\n        siblingLoadedQty: 3,\n        totalConsumedQty: 4,\n        remainingQty: 1,\n        productName: "Phase 4 Product",\n      }),\n    ]);\n  });\n\n  it("reconciles duplicate/case variants and includes finalized history while ignoring cancelled orders", async () => {\n    await syncProformaReservations(ctx.db, ctx.companyId, proformaId);\n    const rows = await pool.query<{ article_code: string; reserved_qty: number }>(\n      \`SELECT article_code, reserved_qty FROM proforma_stock_reservations WHERE company_id=$1 AND proforma_id=$2\`,\n      [ctx.companyId, proformaId]\n    );\n    expect(rows.rows).toHaveLength(1);\n    expect(rows.rows[0]).toEqual(expect.objectContaining({ reserved_qty: 1 }));\n  });\n\n  it("does not subtract in-loading quantity twice from free-to-promise stock", async () => {\n    const response = await agent.get("/api/factory/v2/stock-allocation");\n    expect(response.status).toBe(200);\n    const row = response.body.stockTruth.find((entry: { articleCode: string }) => entry.articleCode.trim().toLowerCase() === "ph4-a");\n    expect(row).toEqual(expect.objectContaining({ reservedNotYetLoaded: 1 }));\n    expect(row.freeToPromise).toBe(row.inStock - 1);\n  });\n});\n`
);

console.log("Phase 4 reconciliation patch applied");
