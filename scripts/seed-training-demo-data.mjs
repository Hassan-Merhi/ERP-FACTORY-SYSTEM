/**
 * Fills the disposable Phase 7 training companies with realistic demo data so
 * that training recordings show real records instead of empty screens.
 *
 * Everything is created through the application's own HTTP endpoints (the same
 * ones the pages call), so stock, vouchers, ledgers and balances stay
 * consistent. Run it after scripts/prepare-phase7-browser-e2e-fixture.mjs
 * against the local disposable CI server; it refuses any other target.
 *
 *   ERP_E2E_USERNAME / ERP_E2E_PASSWORD  fixture Developer credentials
 *   ERP_E2E_DISPOSABLE_DB=1              explicit disposable-database guard
 *   TRAINING_SEED_BASE_URL               default http://127.0.0.1:5000
 *
 * Writes artifacts/training-demo-data/report.json with every step's outcome.
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const base = (process.env.TRAINING_SEED_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const outputDir = path.resolve("artifacts/training-demo-data");

const origin = new URL(base).origin;
if (origin !== "http://127.0.0.1:5000" && origin !== "http://localhost:5000") {
  throw new Error("Training demo data may only be seeded into the local disposable CI application.");
}
if (process.env.ERP_E2E_DISPOSABLE_DB !== "1") throw new Error("ERP_E2E_DISPOSABLE_DB=1 is required");
if (!username || !password) throw new Error("ERP_E2E_USERNAME and ERP_E2E_PASSWORD are required");

let cookie = "";

function idempotencyHeaders() {
  const key = randomUUID();
  return { "x-idempotency-key": key, "idempotency-key": key };
}
const report = [];

async function api(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      // Accounting writes require a stable request identity; each call is a new operation.
      ...(method === "GET" ? {} : idempotencyHeaders()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const header of setCookie) {
    const pair = header.split(";", 1)[0];
    const name = pair.split("=", 1)[0];
    cookie = [...cookie.split("; ").filter((part) => part && !part.startsWith(name + "=")), pair].join("; ");
  }
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text for the report
  }
  if (!response.ok) {
    const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
  }
  return parsed;
}

/** Runs one seeding step; a failure is recorded and the rest of the seed continues. */
async function step(company, name, fn) {
  try {
    const result = await fn();
    report.push({ company, step: name, ok: true });
    return result;
  } catch (error) {
    report.push({ company, step: name, ok: false, error: String(error?.message || error) });
    process.stderr.write(`[${company}] ${name} failed: ${String(error?.message || error)}\n`);
    return undefined;
  }
}

const day = (offset) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const idOf = (row) => Number(row?.id ?? row?.data?.id ?? row?.customer?.id ?? row?.voucher?.id);
const list = (value) => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.rows) ? value.rows : []);

async function selectCompany(code) {
  const companies = await api("GET", "/api/user/companies");
  const company = companies.find((row) => row.companyCode === code);
  if (!company) throw new Error("Fixture company " + code + " is not assigned to the training user");
  await api("POST", "/api/auth/set-company", { companyId: company.companyId });
  return Number(company.companyId);
}

async function ensureAccount(companyId, name, accountType, existing) {
  const found = existing.find((account) => account.name === name);
  if (found) return found;
  return api("POST", "/api/ledger-accounts", { companyId, name, accountType });
}

// ── ERP ────────────────────────────────────────────────────────────────────
async function seedErp() {
  const C = "PHASE7-ERP";
  const companyId = await selectCompany(C);
  const locations = list(await api("GET", "/api/locations"));
  const main = locations.find((row) => row.code === "P7-ERP-A") ?? locations[0];
  const branch = locations.find((row) => row.code === "P7-ERP-B") ?? locations[1] ?? main;
  const accounts = list(await api("GET", "/api/ledger-accounts"));
  const cash = accounts.find((account) => account.code === "P7-CASH") ?? accounts.find((a) => a.accountType === "Cash");
  const expense = await step(C, "expense account", () => ensureAccount(companyId, "Shop Running Costs", "Expense", accounts));
  const rent = await step(C, "rent account", () => ensureAccount(companyId, "Rent Expense", "Expense", accounts));
  const bank = await step(C, "bank account", () => ensureAccount(companyId, "Main Bank", "Bank", accounts));

  const customers = [];
  for (const [legalName, phone] of [
    ["Amani Traders", "+243 810 000 101"],
    ["Bora Wholesale", "+243 810 000 102"],
    ["Kivu Fashion House", "+243 810 000 103"],
    ["Lumbumbashi Retail Co", "+243 810 000 104"],
    ["Nyota Market Stall", "+243 810 000 105"],
  ]) {
    const row = await step(C, "customer " + legalName, () =>
      api("POST", "/api/customers", { legalName, phone, openingBalance: "0", openingBalanceSide: "Dr" })
    );
    if (row) customers.push(row);
  }
  const suppliers = [];
  for (const [legalName, phone] of [
    ["Global Textile Exports", "+44 20 7946 0101"],
    ["Ocean Freight Partners", "+971 4 555 0102"],
    ["Prime Sorting Supplies", "+254 20 555 0103"],
  ]) {
    const row = await step(C, "supplier " + legalName, () =>
      api("POST", "/api/suppliers", { legalName, phone, openingBalance: "0" })
    );
    if (row) suppliers.push(row);
  }
  // Containers on the way, so Tracking shows shipments with ETAs.
  for (const [containerNumber, importOffset, etaOffset, index] of [
    ["MSCU 5528841", -21, 6, 0],
    ["TGHU 9017733", -14, 12, 1],
    ["CAIU 3304162", -7, 19, 0],
  ]) {
    const supplier = suppliers[index];
    if (!supplier) continue;
    await step(C, "container " + containerNumber, () =>
      api("POST", "/api/containers", {
        containerNumber: containerNumber + "-" + companyId,
        supplierId: idOf(supplier),
        status: "OTW",
        importDate: day(importOffset),
        eta: day(etaOffset),
      })
    );
  }

  const groups = list(await api("GET", "/api/stock-groups"));
  const groupId = Number((groups.find((g) => g.code === "P7-GROUP") ?? groups[0])?.id);
  const items = [];
  const catalog = [
    ["TRN-JEANS", "Ladies Jeans Grade A", "PCS", "18.00", 120, "9.50"],
    ["TRN-SHIRT", "Men's Cotton Shirts", "PCS", "12.00", 160, "6.00"],
    ["TRN-KIDS", "Kids Mixed Clothing", "PCS", "8.00", 200, "3.75"],
    ["TRN-SHOES", "Sports Shoes Pairs", "PAIR", "25.00", 80, "14.00"],
    ["TRN-BAG", "Handbags Assorted", "PCS", "15.00", 60, "7.25"],
    ["TRN-DUVET", "Duvets Double", "PCS", "30.00", 40, "18.00"],
  ];
  for (const [code, name, uom, sellingPrice] of catalog) {
    const row = await step(C, "stock item " + code, () =>
      api("POST", "/api/stock-items", { code, name, uom, stockGroupId: groupId, sellingPrice })
    );
    if (row) items.push({ ...row, code });
  }
  let voucherSeq = 1;
  for (const [location, label] of [
    [main, "main"],
    [branch, "branch"],
  ]) {
    if (!location) continue;
    await step(C, "stock receipt " + label, () =>
      api("POST", "/api/stock-adjustments", {
        voucher: { voucherNumber: `TRN-REC-${voucherSeq++}`, voucherDate: day(-28), description: "Opening stock for training", optional: false },
        locationId: Number(location.id),
        adjustmentType: "Production",
        notes: "Training demo stock",
        items: items.map((item) => {
          const spec = catalog.find((entry) => entry[0] === item.code);
          return { stockItemId: idOf(item), quantity: "+" + String(label === "main" ? spec[4] : Math.round(spec[4] / 2)), rate: spec[5] };
        }),
      })
    );
  }

  for (let i = 0; i < 10 && main && cash; i++) {
    const item = items[i % items.length];
    const spec = catalog.find((entry) => entry[0] === item?.code);
    if (!item || !spec) break;
    await step(C, "POS sale " + (i + 1), () =>
      api("POST", "/api/pos/sales", {
        locationId: Number(main.id),
        cashAccountId: idOf(cash),
        // Spread over three weeks with the last few in the current days, so
        // month-to-date reports and today's Daybook have entries.
        voucherDate: day([-24, -20, -16, -12, -8, -5, -3, -2, -1, 0][i]),
        notes: "Training demo sale",
        items: [
          { stockItemId: idOf(item), quantity: 2 + (i % 4), rate: Number(spec[3]) },
          { stockItemId: idOf(items[(i + 2) % items.length]), quantity: 1, rate: Number(catalog[(i + 2) % catalog.length][3]) },
        ],
      })
    );
  }

  if (cash && expense) {
    for (const [amount, notes, account, offset] of [
      [180, "Shop electricity", expense, -18],
      [450, "Monthly shop rent", rent ?? expense, -15],
      [95, "Cleaning and security", expense, 0],
    ]) {
      await step(C, "payment voucher " + notes, () =>
        api("POST", "/api/vouchers/payment-receipt", {
          voucherType: "Payment",
          voucherDate: day(offset),
          paymentAccountType: "ledger",
          paymentAccountId: idOf(cash),
          entries: [{ accountType: "ledger", accountId: idOf(account), accountName: account.name, amount }],
          notes,
        })
      );
    }
  }
  if (cash && customers[0]) {
    await step(C, "receipt voucher", () =>
      api("POST", "/api/vouchers/payment-receipt", {
        voucherType: "Receipt",
        voucherDate: day(-4),
        paymentAccountType: "ledger",
        paymentAccountId: idOf(cash),
        entries: [{ accountType: "customer", accountId: idOf(customers[0]), accountName: customers[0].legalName ?? "Amani Traders", amount: 300 }],
        notes: "Customer settlement",
      })
    );
  }
  if (cash && bank) {
    await step(C, "journal cash to bank", () =>
      api("POST", "/api/vouchers/journal", {
        voucherDate: day(-3),
        notes: "Cash deposited to bank",
        entries: [
          { type: "DR", accountType: "ledger", accountId: idOf(bank), accountName: bank.name, amount: 500 },
          { type: "CR", accountType: "ledger", accountId: idOf(cash), accountName: cash.name, amount: 500 },
        ],
      })
    );
  }
  for (const [firstName, lastName] of [
    ["Grace", "Mwamba"],
    ["Joseph", "Kalonji"],
    ["Esther", "Ilunga"],
  ]) {
    await step(C, "employee " + firstName, () =>
      api("POST", "/api/employees", {
        companyId,
        firstName,
        lastName,
        joinDate: day(-200),
        employeeType: "Employee",
        code: `TRN-${firstName.toUpperCase()}-${companyId}`,
      })
    );
  }
}

// ── Factory ────────────────────────────────────────────────────────────────
async function seedFactory() {
  const C = "PHASE7-FACTORY";
  const companyId = await selectCompany(C);
  // Factory money: a capital injection and running costs, so Accounts,
  // Daybook and Analytics show balances.
  const factoryAccounts = list(await api("GET", "/api/ledger-accounts"));
  const fCash = await step(C, "cash account", () => ensureAccount(companyId, "Factory Cash", "Cash", factoryAccounts));
  const capital = await step(C, "capital account", () => ensureAccount(companyId, "Owner Capital", "Equity", factoryAccounts));
  const utilities = await step(C, "utilities account", () =>
    ensureAccount(companyId, "Factory Electricity & Water", "Expense", factoryAccounts)
  );
  const transport = await step(C, "transport account", () => ensureAccount(companyId, "Transport & Fuel", "Expense", factoryAccounts));
  if (fCash && capital) {
    await step(C, "capital journal", () =>
      api("POST", "/api/vouchers/journal", {
        voucherDate: day(-45),
        notes: "Owner capital for operations",
        entries: [
          { type: "DR", accountType: "ledger", accountId: idOf(fCash), accountName: fCash.name, amount: 25000 },
          { type: "CR", accountType: "ledger", accountId: idOf(capital), accountName: capital.name, amount: 25000 },
        ],
      })
    );
  }
  for (const [amount, notes, account, offset] of [
    [1350, "Generator fuel and electricity", utilities, -20],
    [620, "Truck fuel to Kinshasa", transport, -9],
    [410, "Water and utilities", utilities, -2],
    [180, "Local transport", transport, 0],
  ]) {
    if (!fCash || !account) continue;
    await step(C, "payment " + notes, () =>
      api("POST", "/api/vouchers/payment-receipt", {
        voucherType: "Payment",
        voucherDate: day(offset),
        paymentAccountType: "ledger",
        paymentAccountId: idOf(fCash),
        entries: [{ accountType: "ledger", accountId: idOf(account), accountName: account.name, amount }],
        notes,
      })
    );
  }
  const customers = [];
  for (const legalName of ["Kinshasa Bale Buyers", "Goma Clothing Hub", "Lubumbashi Wholesale"]) {
    const row = await step(C, "customer " + legalName, () =>
      api("POST", "/api/factory/customers", { legalName, openingBalance: "0", openingBalanceSide: "Dr", paymentTermsDays: 30 })
    );
    if (row) customers.push(row);
  }
  const suppliers = [];
  for (const name of ["Euro Textile Recycling", "UK Clothing Collections"]) {
    const row = await step(C, "supplier " + name, () => api("POST", "/api/factory/suppliers", { name, openingBalance: "0" }));
    if (row) suppliers.push(row);
  }
  const workers = [];
  for (const [fullName, position, salaryType, rate] of [
    ["Patrick Mbuyi", "Presser", "Per Bale", { perBaleRate: "0.50" }],
    ["Aline Kasongo", "Sorter", "Daily", { baseSalary: "8.00" }],
    ["Didier Tshibanda", "Sorter", "Daily", { baseSalary: "8.00" }],
    ["Sarah Ngoy", "Supervisor", "Monthly", { baseSalary: "320.00" }],
    ["Moise Kabeya", "Loader", "Daily", { baseSalary: "7.00" }],
  ]) {
    const row = await step(C, "worker " + fullName, () =>
      api("POST", "/api/factory/workers", {
        fullName,
        position,
        salaryType,
        payFrequency: "Monthly",
        paymentMethod: "Cash",
        dateJoined: day(-300),
        active: true,
        ...rate,
      })
    );
    if (row) workers.push(row);
  }

  const products = [];
  for (const [name, grade] of [
    ["Ladies Summer Mix", "CREAM"],
    ["Men's Trousers", "#1"],
    ["Kids Mix", "#2"],
    ["Shoes Mixed", "#3"],
    ["Household Textiles", "#4"],
  ]) {
    const row = await step(C, "bale product " + name, () => api("POST", "/api/factory/bale-products", { name, grade }));
    if (row) products.push(row);
  }

  const supplierId = idOf(suppliers[0]) || undefined;
  for (const [containerNumber, totalKg, ratePerKg, offset] of [
    ["MSKU 4401827", "22000", "0.62", -40],
    ["CMAU 7765104", "24500", "0.58", -12],
  ]) {
    const container = await step(C, "container " + containerNumber, () =>
      api("POST", "/api/factory/containers", {
        containerNumber,
        supplierId,
        totalKg,
        ratePerKg,
        currencyCode: "USD",
        arrivalDate: day(offset),
        freight: "0",
        otherCharges: "0",
        commissionAmount: "0",
      })
    );
    const containerId = idOf(container);
    if (containerId && offset < -20) {
      await step(C, "offload " + containerNumber, () =>
        api("POST", "/api/factory/raw-stock/offload", { containerId, receivedKg: Number(totalKg) - 150 })
      );
    }
  }

  const locations = list(await api("GET", "/api/locations"));
  let location = locations[0];
  if (!location) {
    location = await step(C, "factory warehouse location", () =>
      api("POST", "/api/locations", { name: "Factory Warehouse", code: "FAC-WH" })
    );
  }
  const presser = workers[0];
  if (location && products.length) {
    for (const [offset, mult] of [
      [-25, 6],
      [-18, 8],
      [-10, 7],
      [-3, 9],
      [0, 5],
    ]) {
      await step(C, "stock entry " + day(offset), () =>
        api("POST", "/api/factory/stock-entry", {
          erpLocationId: idOf(location),
          entryDate: day(offset),
          items: products.map((product, index) => ({
            productId: idOf(product),
            qty: Math.max(2, mult - index),
            weightPerBaleKg: 45,
            ...(presser ? { finalizedBy: idOf(presser) } : {}),
          })),
        })
      );
    }
  }

  if (customers[0] && products.length) {
    const lines = products.slice(0, 3).map((product, index) => ({
      articleCode: product.articleCode ?? product.code,
      productName: product.name,
      quantity: 4 + index,
      pricePerBale: [62, 48, 40][index],
    }));
    await step(C, "proforma", () =>
      api("POST", "/api/factory/customer-proformas/bulk", {
        customerId: idOf(customers[0]),
        name: "Training Proforma November",
        destination: "Kinshasa",
        isActive: true,
        lines,
      })
    );
    if (customers[1]) {
      await step(C, "stock allocation proforma with loading", () =>
        api("POST", "/api/factory/v5/proforma-with-loading", {
          customerId: idOf(customers[1]),
          name: "Training Allocation Goma",
          destination: "Goma",
          isActive: true,
          lines,
          sendToLoading: true,
          containerNames: ["C1", "C2"],
        })
      );
    }
  }

  if (workers.length) {
    await step(C, "attendance today", () =>
      api("POST", "/api/factory/attendance/bulk", {
        records: workers.map((worker, index) => ({
          workerId: idOf(worker),
          attendanceDate: day(0),
          status: index === 2 ? "Late" : "Present",
        })),
      })
    );
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 1);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    await step(C, "draft payroll last month", () =>
      api("POST", "/api/factory/payrolls/generate-bulk", {
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: end.toISOString().slice(0, 10),
        workerIds: workers.map(idOf),
        notes: "Training payroll (draft, unpaid)",
      })
    );
  }
}

// ── Supplier Partner ───────────────────────────────────────────────────────
async function seedSupplierPartner() {
  const C = "PHASE7-SP";
  await selectCompany(C);
  await step(C, "setup", () =>
    api("POST", "/api/sp/setup", { confirmation: "CHANGE SP SETUP", reason: "Training demo company setup" })
  );
  const accounts = list(await api("GET", "/api/ledger-accounts"));
  const cash = accounts.find((account) => account.accountType === "Cash");
  const items = list(await api("GET", "/api/stock-items"));
  const item = items[0];
  if (item) {
    await step(C, "opening stock", () =>
      api("POST", "/api/sp/opening-stock", {
        articleCode: item.code,
        stockItemId: idOf(item),
        qty: 40,
        baseUnitCostUsd: 11,
        landedUnitCostUsd: 13,
        finalUnitCostUsd: 14,
        confirmation: "POST SP OPENING STOCK",
        reason: "Training demo opening stock",
      })
    );
  }
  for (let i = 0; i < 4 && item && cash; i++) {
    await step(C, "sale " + (i + 1), () =>
      api("POST", "/api/sp/sales", {
        saleDate: day(-12 + i * 3),
        customerName: ["Mama Furaha", "Boutique Elikya", "Chez Papy", "Market Stall 14"][i],
        saleLines: [{ stockItemId: idOf(item), articleCode: item.code, qtySold: 2 + i, salePricePerUnit: 30 }],
        paymentAccountType: "cash",
        paymentAccountId: idOf(cash),
        notes: "Training demo sale",
      })
    );
  }
}

await api("POST", "/api/auth/login", { username, password });
for (const seed of [seedErp, seedFactory, seedSupplierPartner]) {
  try {
    await seed();
  } catch (error) {
    report.push({ company: seed.name, step: "company", ok: false, error: String(error?.message || error) });
    process.stderr.write(`${seed.name} failed: ${String(error?.message || error)}\n`);
  }
}

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
const ok = report.filter((entry) => entry.ok).length;
const failed = report.filter((entry) => !entry.ok);
console.log(`Training demo data: ${ok} steps succeeded, ${failed.length} failed`);
const byCompany = new Map();
for (const entry of report) byCompany.set(entry.company, (byCompany.get(entry.company) ?? 0) + (entry.ok ? 1 : 0));
if ([...byCompany.values()].some((count) => count === 0)) {
  console.error("A training company received no demo data; recordings would be empty.");
  process.exitCode = 1;
}
