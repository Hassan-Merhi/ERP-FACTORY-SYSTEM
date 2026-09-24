#!/usr/bin/env node
/**
 * Seeds the ERP mobile program certification company with enough records for
 * list, card and report screens to render real rows on phones.
 *
 * Everything is created through the application's own API, so validation,
 * ledger posting and company isolation run exactly as they do for users. The
 * script is safe to rerun: master data is matched by code or name, and
 * vouchers use stable idempotency keys.
 *
 * Usage:
 *   ERP_SMOKE_USERNAME=... ERP_SMOKE_PASSWORD=... \
 *     node scripts/prepare-erp-mobile-program-fixture.mjs [--company=PHASE9-ERP]
 *
 * Never point it at a production database: it writes vouchers.
 */

const BASE_URL = process.env.ERP_MOBILE_PROGRAM_BASE_URL || "http://127.0.0.1:5000";
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  })
);
const COMPANY_CODE = args.company || process.env.ERP_MOBILE_PROGRAM_COMPANY || "PHASE9-ERP";
const USERNAME = process.env.ERP_SMOKE_USERNAME;
const PASSWORD = process.env.ERP_SMOKE_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("The ERP mobile program fixture requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

let cookie = "";

async function call(method, url, body) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    const token = await fetch(`${BASE_URL}/api/csrf-token`, { headers: { cookie } })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    if (token.csrfToken) headers["x-csrf-token"] = token.csrfToken;
  }
  const response = await fetch(`${BASE_URL}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const setCookie of response.headers.getSetCookie?.() ?? []) {
    const pair = setCookie.split(";")[0];
    const name = pair.split("=")[0];
    cookie = [...cookie.split("; ").filter((c) => c && !c.startsWith(`${name}=`)), pair].join("; ");
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const GROUPS = [
  { code: "CLOTH", name: "Clothing" },
  { code: "SHOES", name: "Footwear" },
  { code: "BAGS", name: "Bags and accessories" },
];

const ITEMS = [
  ["CLOTH", "SHIRT-01", "Cotton shirt mix", "KG", "2.50"],
  ["CLOTH", "SHIRT-02", "Men's short sleeve shirts grade A", "KG", "3.10"],
  ["CLOTH", "TROUS-01", "Denim trousers", "KG", "2.80"],
  ["CLOTH", "DRESS-01", "Ladies summer dresses", "KG", "3.40"],
  ["CLOTH", "JACKET-01", "Winter jackets mixed", "KG", "1.90"],
  ["CLOTH", "KIDS-01", "Children's mixed clothing", "KG", "2.20"],
  ["CLOTH", "SPORT-01", "Sportswear tracksuits", "KG", "2.60"],
  ["CLOTH", "SKIRT-01", "Skirts light cotton", "KG", "2.95"],
  ["CLOTH", "TSHIRT-01", "T-shirts premium cream", "KG", "3.60"],
  ["CLOTH", "LINEN-01", "Household linen and towels", "KG", "1.40"],
  ["SHOES", "SHOE-01", "Leather shoes men", "PAIR", "4.50"],
  ["SHOES", "SHOE-02", "Sneakers mixed sizes", "PAIR", "3.90"],
  ["SHOES", "SHOE-03", "Ladies sandals", "PAIR", "2.30"],
  ["SHOES", "SHOE-04", "Children's shoes", "PAIR", "2.10"],
  ["SHOES", "BOOT-01", "Work boots", "PAIR", "5.20"],
  ["BAGS", "BAG-01", "Handbags assorted", "PCS", "1.75"],
  ["BAGS", "BAG-02", "School backpacks", "PCS", "2.40"],
  ["BAGS", "BELT-01", "Leather belts", "PCS", "0.90"],
  ["BAGS", "CAP-01", "Caps and hats", "PCS", "0.60"],
  ["BAGS", "TOY-01", "Soft toys", "KG", "1.20"],
];

const CUSTOMERS = [
  "Atlas Trading SARL",
  "Baobab Retail Group",
  "Cotonou Market Stores",
  "Dakar Fashion Hub",
  "Espoir Distribution",
  "Fleuve Commerce",
  "Grand Marché Wholesale",
  "Horizon Boutique Chain",
  "Ivoire Textile Traders",
  "Jardin Kids Outlet",
  "Kora Second-Hand Depot",
  "Lagune Import Export",
];

const SUPPLIERS = [
  ["NORDIC", "Nordic Textiles AB"],
  ["BALTIC", "Baltic Recycling Oy"],
  ["IBERIA", "Iberia Sorting Centre SL"],
  ["RHEIN", "Rhein Garments GmbH"],
  ["ALPINE", "Alpine Collection AG"],
  ["THAMES", "Thames Clothing Recovery Ltd"],
];

const LEDGERS = [
  { name: "Main Cash", accountType: "Asset", subType: "Current Asset" },
  { name: "Operating Bank", accountType: "Asset", subType: "Current Asset" },
  { name: "Transport Expense", accountType: "Expense", subType: "Indirect Expense" },
  { name: "Warehouse Rent", accountType: "Expense", subType: "Indirect Expense" },
  { name: "Staff Salaries", accountType: "Expense", subType: "Indirect Expense" },
];

async function main() {
  await call("GET", "/api/csrf-token");
  await call("POST", "/api/auth/login", { username: USERNAME, password: PASSWORD });
  const companies = await call("GET", "/api/user/companies");
  const company = companies.find((c) => c.companyCode === COMPANY_CODE);
  if (!company) throw new Error(`Company ${COMPANY_CODE} is not available to the certification user.`);
  await call("POST", "/api/auth/set-company", { companyId: company.companyId });
  const companyId = company.companyId;

  const locations = await call("GET", "/api/locations");
  if (!locations.some((l) => l.code === "MAIN")) {
    await call("POST", "/api/locations", { code: "MAIN", name: "Main Warehouse" });
  }

  const groups = await call("GET", "/api/stock-groups");
  const groupIds = {};
  for (const group of GROUPS) {
    const existing = groups.find((g) => g.code === group.code);
    groupIds[group.code] = existing ? existing.id : (await call("POST", "/api/stock-groups", group)).id;
  }

  const items = await call("GET", "/api/stock-items");
  const itemList = Array.isArray(items) ? items : (items.items ?? items.data ?? []);
  for (const [groupCode, code, name, uom, price] of ITEMS) {
    if (itemList.some((i) => i.code === code)) continue;
    await call("POST", "/api/stock-items", { code, name, uom, stockGroupId: groupIds[groupCode], sellingPrice: price });
  }

  const customers = await call("GET", "/api/customers");
  const customerList = Array.isArray(customers) ? customers : (customers.items ?? customers.data ?? []);
  for (const legalName of CUSTOMERS) {
    if (customerList.some((c) => c.legalName === legalName)) continue;
    await call("POST", "/api/customers", { name: legalName, legalName, phone: "+221 77 000 00 00" });
  }

  const suppliers = await call("GET", "/api/suppliers");
  const supplierList = Array.isArray(suppliers) ? suppliers : (suppliers.items ?? suppliers.data ?? []);
  for (const [code, legalName] of SUPPLIERS) {
    if (supplierList.some((s) => s.code === code || s.legalName === legalName)) continue;
    await call("POST", "/api/suppliers", { code, name: legalName, legalName });
  }

  const supplierIds = (await call("GET", "/api/suppliers"))
    .filter((s) => SUPPLIERS.some(([code]) => code === s.code))
    .map((s) => s.id);
  const containers = await call("GET", "/api/containers");
  const containerList = Array.isArray(containers) ? containers : (containers.items ?? containers.data ?? []);
  const transporters = ["Sahel Logistics", "Continental Freight", "Atlantic Haulage"];
  const places = ["Port of Dakar", "Kidira border", "Tambacounda", "Bamako yard", "Kayes checkpoint"];
  for (let i = 0; i < 8; i += 1) {
    const containerNumber = `MPCU${String(4100200 + i)}`;
    if (containerList.some((c) => c.containerNumber === containerNumber)) continue;
    const day = String(2 + i * 3).padStart(2, "0");
    await call("POST", "/api/containers", {
      containerNumber,
      supplierId: supplierIds[i % supplierIds.length],
      importDate: `2026-09-${day}`,
      itemName: ITEMS[i % ITEMS.length][2],
      totalKg: String(18000 + i * 750),
      ratePerKg: (0.7 + i * 0.05).toFixed(2),
      shopName: ["Central", "Plateau", "Medina"][i % 3],
      eta: `2026-10-${day}`,
      transporter: transporters[i % transporters.length],
      numberPlate: `DK-${4400 + i}-B`,
      trackingLocation: places[i % places.length],
      borderDate: i % 2 ? `2026-09-${String(10 + i).padStart(2, "0")}` : undefined,
      agent: ["Diallo", "Ndiaye", "Traoré"][i % 3],
      transportFee: String(1500 + i * 120),
      dutyFee: String(800 + i * 60),
    });
  }

  let ledgers = await call("GET", "/api/ledger-accounts");
  for (const ledger of LEDGERS) {
    if (ledgers.some((l) => l.name === ledger.name)) continue;
    await call("POST", "/api/ledger-accounts", { companyId, ...ledger });
  }
  ledgers = await call("GET", "/api/ledger-accounts");
  const byName = (name) => {
    const account = ledgers.find((l) => l.name === name);
    if (!account) throw new Error(`Ledger ${name} was not created.`);
    return account;
  };
  const cash = byName("Main Cash");
  const bank = byName("Operating Bank");
  const expenses = ["Transport Expense", "Warehouse Rent", "Staff Salaries"].map(byName);
  const receivables = ledgers
    .filter((l) => l.subType === "Accounts Receivable")
    .sort((a, b) => a.id - b.id)
    .slice(0, 12);

  const entry = (type, account, amount) => ({
    type,
    accountType: "ledger",
    accountId: account.id,
    accountName: account.name,
    amount: amount.toFixed(2),
  });

  const vouchers = [];
  for (let i = 0; i < 36; i += 1) {
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = i < 18 ? "08" : "09";
    const amount = 150 + ((i * 137) % 2400);
    if (i % 3 === 0 && receivables.length) {
      const customer = receivables[i % receivables.length];
      vouchers.push({
        notes: `Receipt from ${customer.name.replace(/ - Customer Account$/, "")}`,
        voucherDate: `2026-${month}-${day}`,
        entries: [entry("DR", i % 2 ? bank : cash, amount), entry("CR", customer, amount)],
      });
    } else if (i % 3 === 1 && receivables.length) {
      const customer = receivables[(i * 5) % receivables.length];
      vouchers.push({
        notes: `Credit sale adjustment ${customer.name.replace(/ - Customer Account$/, "")}`,
        voucherDate: `2026-${month}-${day}`,
        entries: [entry("DR", customer, amount), entry("CR", bank, amount)],
      });
    } else {
      const expense = expenses[i % expenses.length];
      vouchers.push({
        notes: `${expense.name} ${month === "08" ? "August" : "September"} batch ${i + 1}`,
        voucherDate: `2026-${month}-${day}`,
        entries: [entry("DR", expense, amount), entry("CR", cash, amount)],
      });
    }
  }

  let created = 0;
  for (const [index, voucher] of vouchers.entries()) {
    try {
      await call("POST", "/api/vouchers/journal", {
        clientRequestId: `erp-mobile-program-fixture-${COMPANY_CODE}-${index}`,
        ...voucher,
      });
      created += 1;
    } catch (error) {
      // A key already used by an earlier run means this voucher is already seeded.
      if (!String(error.message).includes("POSTING_IDEMPOTENCY_CONFLICT")) throw error;
    }
  }

  console.log(
    JSON.stringify({
      company: COMPANY_CODE,
      stockItems: ITEMS.length,
      customers: CUSTOMERS.length,
      suppliers: SUPPLIERS.length,
      containers: 8,
      vouchers: created,
    })
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
