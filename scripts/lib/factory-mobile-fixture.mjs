/**
 * Factory mobile regression fixture.
 *
 * Resolves (and, when `createMissing` is set, creates) one realistic record of each kind the
 * Factory detail/workflow routes need, so the rendered regression sees tables with rows rather
 * than empty states: customer, draft order with scanned bales, dispatch batch and ride, employee
 * with a deposit, worker with an advance and payroll, ledger accounts with a journal voucher,
 * location, bale product with bales in stock, proforma with a line, raw-stock opening balance,
 * contacts and sheets & sacks items.
 *
 * Every call goes through the application's own Factory APIs in the signed-in browser session,
 * so posting rules and validation are the real ones. Creation is idempotent (each record is only
 * created when its list is empty) and must only ever target a disposable fixture company.
 */

/** Runs inside the page. Returns the ids the seeded routes need. */
async function resolveInPage({ seeds, createMissing, companyId }) {
  const request = async (method, url, body) => {
    try {
      const response = await fetch(url, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    }
  };
  const rows = (body) => {
    if (Array.isArray(body)) return body;
    for (const key of ["items", "data", "rows", "orders", "batches"]) {
      if (Array.isArray(body?.[key])) return body[key];
    }
    return [];
  };
  const firstId = (list, predicate = () => true) => {
    const id = Number(list.find((row) => Number(row?.id) > 0 && predicate(row))?.id);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  };
  const list = async (url) => rows(await request("GET", url));
  const create = async (url, body) => (createMissing ? request("POST", url, body) : undefined);
  const today = "2026-09-20";
  const out = { ...seeds };

  // Accounting: cash + income ledger accounts and one balanced journal.
  const accounts = await list("/api/ledger-accounts?includeHidden=true&profile=picker");
  let cash = firstId(accounts, (a) => a.accountType === "Asset");
  let income = firstId(accounts, (a) => a.accountType === "Income");
  cash ??= firstId([
    await create("/api/ledger-accounts", { companyId, name: "Cash Box", code: "MA-1001", accountType: "Asset" }),
  ]);
  income ??= firstId([
    await create("/api/ledger-accounts", { companyId, name: "Sales Income", code: "MA-4001", accountType: "Income" }),
  ]);
  out.account ??= cash;
  out.voucher ??= firstId(await list("/api/vouchers?limit=5"));
  if (!out.voucher && cash && income) {
    const created = await create("/api/vouchers/with-entries", {
      voucher: {
        voucherNumber: "MA-JV-1",
        voucherType: "Journal",
        voucherDate: today,
        totalAmount: "250.00",
        description: "Mobile audit journal",
      },
      entries: [
        { ledgerAccountId: cash, debitAmount: "250.00", creditAmount: "0", description: "Cash sale" },
        { ledgerAccountId: income, debitAmount: "0", creditAmount: "250.00", description: "Cash sale" },
      ],
    });
    out.voucher = firstId([created?.voucher]);
  }

  // Inventory: a location, a bale product and four bales in stock.
  out.location ??=
    firstId(await list("/api/locations")) ??
    firstId([await create("/api/locations", { name: "Main Warehouse", code: "MAIN" })]);
  out.product ??=
    firstId(await list("/api/factory/bale-products")) ??
    firstId([await create("/api/factory/bale-products", { name: "Cotton Mix A", articleCode: "CMA-01" })]);
  let inStock = await list("/api/factory/stock-entry/in-stock");
  if (inStock.length === 0 && out.product && out.location) {
    await create("/api/factory/stock-entry", {
      erpLocationId: out.location,
      items: [{ productId: out.product, qty: 4, weightPerBaleKg: "45", finalizedBy: null }],
      entryDate: today,
      customerId: null,
      logoId: null,
    });
    inStock = await list("/api/factory/stock-entry/in-stock");
  }

  // Sales: customer, draft order with two scanned bales, proforma with a line, dispatch batch/ride.
  out.customer ??=
    firstId(await list("/api/factory/customers")) ??
    firstId([await create("/api/factory/customers", { legalName: "Mobile Audit Textiles LLC", phone: "+961 1 000000" })]);
  if (!out.order) {
    out.order = firstId(await list("/api/factory/customer-orders"));
    if (!out.order && out.customer) {
      out.order = firstId([
        await create("/api/factory/customer-orders", { customerId: out.customer, orderDate: today, currency: "USD" }),
      ]);
      for (const bale of inStock.slice(0, 2)) {
        await create(`/api/factory/customer-orders/${out.order}/bales`, {
          scanCode: bale.referenceNumber,
          locationId: out.location,
        });
      }
    }
  }
  if (out.customer && !out.proforma) {
    out.proforma = firstId(await list(`/api/factory/customer-proformas?customerId=${out.customer}`));
    if (!out.proforma) {
      out.proforma = firstId([
        await create("/api/factory/customer-proformas", { customerId: out.customer, name: "PF-MOBILE-01" }),
      ]);
      if (out.proforma) {
        await create("/api/factory/customer-proforma-lines", {
          proformaId: out.proforma,
          articleCode: "CMA-01",
          productName: "Cotton Mix A",
          quantity: 20,
          pricePerBale: "38.50",
          weightPerBaleKg: "45",
        });
      }
    }
  }
  out.batch ??=
    firstId(await list("/api/factory/dispatch-batches")) ??
    (out.customer
      ? firstId([
          (await create("/api/factory/dispatch-batches", { customerId: out.customer, batchDate: today, currency: "USD" }))
            ?.batch,
        ])
      : undefined);
  if (out.batch && !out.ride) {
    out.ride = firstId((await request("GET", `/api/factory/dispatch-batches/${out.batch}`))?.rides ?? []);
    out.ride ??= firstId([
      await create(`/api/factory/dispatch-batches/${out.batch}/truck-rides`, { driverName: "Mobile Audit" }),
    ]);
  }

  // People: employee with a deposit, worker with an advance and a payroll period.
  if (!out.employee) {
    out.employee = firstId(await list("/api/factory/employees"));
    if (!out.employee) {
      out.employee = firstId([
        await create("/api/factory/employees", { firstName: "Rania", lastName: "Khoury", joinDate: "2026-01-05", active: true }),
      ]);
      if (out.employee) {
        await create(`/api/factory/employees/${out.employee}/deposit`, { amount: "400", date: "2026-09-05", notes: "Salary deposit" });
      }
    }
  }
  if (!out.worker) {
    out.worker = firstId(await list("/api/factory/workers"));
    if (!out.worker) {
      out.worker = firstId([await create("/api/factory/workers", { fullName: "Karim Nasser", active: true })]);
      if (out.worker && cash) {
        await create("/api/factory/advances/bulk", {
          items: [{ workerId: out.worker, amount: "150" }],
          advanceDate: "2026-09-10",
          cashAccountId: cash,
          notes: "Mobile audit advance",
        });
        await create("/api/factory/payroll/generate", { companyId, startDate: "2026-09-01", endDate: "2026-09-15" });
      }
    }
  }

  // Raw materials opening balance (its edit form is a Phase 10 route).
  if (!out.openingBalance) {
    // Per-record list (the default raw-stock list is aggregated by supplier and carries no ids).
    const records = await list("/api/factory/raw-stock/by-container");
    out.openingBalance = firstId(records, (row) => row.containerStatus === "OPENING_BALANCE");
    if (!out.openingBalance) {
      const created = await create("/api/factory/raw-stock/opening-balance", {
        supplierName: "Harbor Recycling",
        receivedKg: "12000",
        costPerKg: "0.42",
        currencyCode: "USD",
      });
      out.openingBalance = firstId([created?.rawStock]);
    }
  }

  // An on-the-way container, so the container list, its detail dialog and OTW tracking have rows.
  const containers = await list("/api/factory/containers");
  if (!containers.some((container) => container.status === "OTW")) {
    const raw = await list("/api/factory/raw-stock?profile=list");
    const supplierId = raw.find((row) => Number(row.supplierId) > 0)?.supplierId ?? null;
    await create("/api/factory/containers", {
      containerNumber: "MSCU7654321",
      supplierId,
      status: "OTW",
      currencyCode: "USD",
      fxRateToUsd: "1",
      fxRateSource: "auto",
      totalKg: "18000",
      ratePerKg: "0.45",
      commissionAmount: "0",
      commissionCurrencyCode: "USD",
      freight: "0",
      freightCurrencyCode: "USD",
      otherCharges: "0",
    });
  }

  // Top-level lists with rows.
  if ((await list("/api/factory/contacts")).length === 0) {
    await create("/api/factory/contacts", {
      name: "Amina Haddad",
      role: "Supplier agent",
      notes: "Calls after 5pm about container arrivals and loading slots",
      numbers: [
        { label: "Mobile", number: "+961 70 000 000" },
        { label: "Office", number: "+961 1 555 010" },
      ],
    });
  }
  if ((await list("/api/factory/sheets-sacks")).length === 0) {
    await create("/api/factory/sheets-sacks", {
      type: "SACK",
      name: "Woven sack 60x90",
      size: "60x90",
      packQty: "12",
      pcsPerPack: "100",
      quantity: "1200",
      unitPrice: "0.18",
      notes: "Blue stripe",
    });
  }
  return out;
}

/**
 * Resolves the seeded ids for the Factory mobile regression, creating missing records when
 * `createMissing` is true. `page` must be signed in with the fixture company selected.
 */
export async function resolveFactoryMobileSeeds(page, { seeds = {}, createMissing = false, companyId }) {
  return page.evaluate(resolveInPage, { seeds, createMissing, companyId });
}
