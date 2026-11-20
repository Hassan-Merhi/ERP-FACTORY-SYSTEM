/**
 * AI import row validation (dispatcher, suppliers, vouchers) against
 * PostgreSQL in one rolled-back transaction per test. Pins every column-name
 * alias, duplicate-code refusals, correction-memory account resolution and
 * its fallbacks, date / type / amount refusals and the generic fallback.
 *
 * Pinned bug: validateSupplierRows reads existing supplier codes from every
 * company (no company filter), so a code used only by another company is
 * refused as "already exists" although the unique index is per company.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import { validateRows } from "../server/routes/ai-import/_helpers";

const rows = (...raw: unknown[]) => raw.map((rawData, i) => ({ id: i + 1, rowNumber: i + 1, rawData }));

const supplierRow = (w: ReportWorld, code: string, companyId = w.companyId) =>
  w.q(`INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Existing', '')`, [companyId, code]);

describe("validateRows dispatch", () => {
  it("passes unknown import types through with a warning", () =>
    withReportWorld(async (w) => {
      expect(await validateRows(w.companyId, "mystery", rows({ a: 1 }))).toEqual([
        {
          id: 1,
          status: "valid",
          mappedData: { a: 1 },
          errors: [],
          warnings: ["importType not recognized — no validation applied"],
        },
      ]);
    }));

  it("routes stock items and customers to their validators", () =>
    withReportWorld(async (w) => {
      const [stock] = await validateRows(w.companyId, "stock_items", rows({}));
      expect(stock.status).toBe("error");
      const [customer] = await validateRows(w.companyId, "customers", rows({}));
      expect(customer.status).toBe("error");
    }));
});

describe("supplier rows", () => {
  it("accepts every name / code / contact alias and refuses blanks and duplicates", () =>
    withReportWorld(async (w) => {
      await supplierRow(w, `${w.tag}OLD`);
      const result = await validateRows(
        w.companyId,
        "suppliers",
        rows(
          { legalName: " Acme ", code: `${w.tag}A`, phone: " 1 ", email: "a@x", openingBalance: "12.5" },
          { "Legal Name": "Beta", Code: `${w.tag}B`, Phone: "2", Email: "b@x", "Opening Balance": "3" },
          { name: "Gamma", code: `${w.tag}a` },
          { Name: "Delta", code: `${w.tag}old` },
          {}
        )
      );
      expect(result.map((r) => [r.status, r.errors])).toEqual([
        ["valid", []],
        ["valid", []],
        ["error", [`code "${w.tag}a" duplicated within this import`]],
        ["error", [`code "${w.tag}old" already exists`]],
        ["error", ["legalName is required"]],
      ]);
      expect(result[0].mappedData).toEqual({
        legalName: "Acme",
        code: `${w.tag}A`,
        phone: "1",
        email: "a@x",
        openingBalance: "12.5",
      });
      expect(result[1].mappedData).toMatchObject({ legalName: "Beta", phone: "2", email: "b@x", openingBalance: "3" });
      expect(result[4].mappedData).toMatchObject({ code: null, phone: null, email: null, openingBalance: "0" });
    }));

  it("refuses a code that exists only in another company (pinned cross-company check)", () =>
    withReportWorld(async (w) => {
      const other = await w.otherCompany();
      await supplierRow(w, `${w.tag}X`, other);
      const [r] = await validateRows(w.companyId, "suppliers", rows({ legalName: "Mine", code: `${w.tag}X` }));
      expect(r.errors).toEqual([`code "${w.tag}X" already exists`]);
    }));
});

describe("voucher rows", () => {
  it("resolves accounts by code, name and correction memory across column aliases", () =>
    withReportWorld(async (w) => {
      const cash = await w.ledger("Main Cash", "Cash");
      const rent = await w.ledger("Rent", "Expense");
      const [cashCode] = await w.q<{ code: string }>(`SELECT code FROM ledger_accounts WHERE id = $1`, [cash]);
      const memory = (raw: string, resolvedId: number, resolvedValue: string | null, confidence = 100) =>
        w.q(
          `INSERT INTO ai_correction_memory (company_id, memory_type, raw_value, resolved_id, resolved_value, confidence, created_by)
           VALUES ($1, 'ledger_alias', $2, $3, $4, $5, 'tester')`,
          [w.companyId, raw, resolvedId, resolvedValue, confidence]
        );
      await memory("petty", cash, "Main Cash");
      await memory("ghost", 987654, "Ghost Account");
      await memory("nameless", 987655, null);
      await memory("weak", rent, "Rent", 50);
      const result = await validateRows(
        w.companyId,
        "vouchers",
        rows(
          { date: "2026-01-02", type: "Payment", debitAccount: "rent", creditAccount: cashCode.code, amount: "10" },
          {
            Date: "2026-01-03",
            Type: "Receipt",
            "Debit Account": "PETTY",
            "Credit Account": "Rent",
            Amount: 5,
            Description: "d",
          },
          {
            "Voucher Date": "2026-01-04",
            "Voucher Type": "Journal",
            debitAccount: "ghost",
            creditAccount: "nameless",
            amount: "1",
            narration: "n",
          },
          { date: "2026-01-05", type: "Journal", debitAccount: "weak", creditAccount: "rent", amount: "1" }
        )
      );
      expect(result.map((r) => r.status)).toEqual(["valid", "valid", "valid", "error"]);
      expect(result[0].mappedData).toMatchObject({ debitAccountId: rent, creditAccountId: cash, amount: "10.00" });
      expect(result[1].mappedData).toMatchObject({ debitAccountId: cash, creditAccountId: rent, description: "d" });
      expect(result[2].mappedData).toMatchObject({ debitAccountId: 987654, creditAccountId: 987655, description: "n" });
      expect(result[3].errors).toEqual(['debit account "weak" not found']);
    }));

  it("refuses missing or malformed date, type, accounts and amount", () =>
    withReportWorld(async (w) => {
      const result = await validateRows(
        w.companyId,
        "vouchers",
        rows(
          {},
          { date: "02/01/2026", type: "Sale", debitAccount: "nope", creditAccount: "nada", amount: "abc" },
          { date: "2026-01-01", type: "Payment", debitAccount: "x", creditAccount: "y", amount: "-4" }
        )
      );
      expect(result[0].errors).toEqual([
        "date is required",
        'type must be Payment, Receipt, or Journal — got ""',
        "debitAccount is required",
        "creditAccount is required",
        "amount must be a positive number",
      ]);
      expect(result[1].errors).toEqual([
        'date "02/01/2026" must be YYYY-MM-DD',
        'type must be Payment, Receipt, or Journal — got "Sale"',
        'debit account "nope" not found',
        'credit account "nada" not found',
        "amount must be a positive number",
      ]);
      expect(result[1].mappedData).toMatchObject({ amount: "0", debitAccountId: null, creditAccountId: null });
      expect(result[2].mappedData).toMatchObject({ amount: "-4.00" });
    }));
});
