/**
 * parseCashBankStatement reads a customer's bank or cash statement for
 * reconciliation. It must accept the column shapes banks actually export,
 * never guess an ambiguous date or lose precision, and reject anything it
 * cannot read exactly, naming the row.
 */
import ExcelJS from "exceljs";
import {
  BankStatementParseError,
  parseCashBankStatement,
  statementDate,
} from "../server/services/accounting/cashBankStatementParser";

const csv = (text: string, name = "statement.csv") => ({ buffer: Buffer.from(text, "utf8"), originalname: name });
const parse = (file: { buffer: Buffer; originalname: string }, start = "2026-01-01", end = "2026-12-31") =>
  parseCashBankStatement(file, start, end);

describe("statement dates", () => {
  it.each([
    ["2026-03-04", "2026-03-04"],
    ["04/03/2026", "2026-03-04"],
    [new Date("2026-03-04T15:00:00Z"), "2026-03-04"],
  ])("reads %j as %s", (value, expected) => {
    expect(statementDate(value)).toBe(expected);
  });

  it.each(["03-04-2026", "2026-02-30", "31/02/2026", "4/3/2026", "", new Date("x")])(
    "rejects the ambiguous or impossible date %j",
    (value) => {
      expect(() => statementDate(value)).toThrow(BankStatementParseError);
    }
  );
});

describe("CSV statements", () => {
  it("reads signed amounts, references, descriptions and running balances", async () => {
    const lines = await parse(
      csv(
        "﻿Date,Description,Reference,Amount,Balance\r\n" +
          '2026-01-02,"Deposit, cash",DEP-1,"1,250.50","1,250.50"\r\n' +
          '05/01/2026,"Fee ""monthly""",,(12.5),1238\n' +
          "\n" +
          "2026-01-06,,,-0.000001,"
      )
    );

    expect(lines).toEqual([
      {
        rowNumber: 1,
        transactionDate: "2026-01-02",
        signedAmount: "1250.500000",
        reference: "DEP-1",
        description: "Deposit, cash",
        runningBalance: "1250.500000",
      },
      {
        rowNumber: 2,
        transactionDate: "2026-01-05",
        signedAmount: "-12.500000",
        reference: null,
        description: 'Fee "monthly"',
        runningBalance: "1238.000000",
      },
      {
        rowNumber: 3,
        transactionDate: "2026-01-06",
        signedAmount: "-0.000001",
        reference: null,
        description: null,
        runningBalance: null,
      },
    ]);
  });

  it("reads separate debit and credit columns with alternative header names", async () => {
    const lines = await parse(
      csv(
        "Transaction Date,Details,Ref,Debit,Credit,Running_Balance\n2026-02-01,Rent,R1,500,,100\n2026-02-02,Sale,S1,,75.25,175.25"
      )
    );

    expect(lines.map((line) => [line.signedAmount, line.reference, line.description, line.runningBalance])).toEqual([
      ["-500.000000", "R1", "Rent", "100.000000"],
      ["75.250000", "S1", "Sale", "175.250000"],
    ]);
  });

  it("uses a narration column as the description", async () => {
    const [line] = await parse(csv("date,amount,narration\n2026-02-01,5,Petty cash"));
    expect(line.description).toBe("Petty cash");
  });

  it.each([
    ["no data rows", "Date,Amount\n", "header and at least one data row"],
    ["no date column", "When,Amount\n2026-01-01,5", "Missing Date column"],
    ["no amount columns", "Date,Value\n2026-01-01,5", "Missing Amount or Debit/Credit columns"],
    ["a date outside the period", "Date,Amount\n2025-12-31,5", "Row 2: date is outside"],
    ["a zero transaction", "Date,Amount\n2026-01-01,0", "Row 2: zero transactions"],
    ["an empty amount", "Date,Amount\n2026-01-01,", "nonempty numeric amount"],
    ["a non-numeric amount", "Date,Amount\n2026-01-01,12abc", 'Invalid amount "12abc"'],
    ["too many decimals", "Date,Amount\n2026-01-01,1.1234567", "Invalid amount"],
    ["an enormous amount", "Date,Amount\n2026-01-01,100000000000000", "exceeds supported currency precision"],
    [
      "both debit and credit",
      "Date,Debit,Credit\n2026-01-01,5,6",
      "Row 2: Debit/Credit must be nonnegative and exclusive",
    ],
    ["a negative credit", "Date,Debit,Credit\n2026-01-01,,-6", "Debit/Credit must be nonnegative"],
    ["a bad running balance", "Date,Amount,Balance\n2026-01-01,5,lots", 'Invalid amount "lots"'],
    ["an unclosed quote", 'Date,Amount\n2026-01-01,"5', "Unclosed quoted CSV cell"],
    ["a stray quote", 'Date,Amount\n2026-01-01,5"x"', "Malformed CSV quoting"],
  ])("rejects %s", async (_label, text, message) => {
    await expect(parse(csv(text))).rejects.toThrow(message);
  });

  it("rejects more than 5,000 rows and files that are neither CSV nor XLSX", async () => {
    const rows = Array.from({ length: 5001 }, () => "2026-01-01,1").join("\n");
    await expect(parse(csv(`Date,Amount\n${rows}`))).rejects.toThrow("1 to 5,000 transaction rows");
    await expect(parse(csv("Date,Amount\n2026-01-01,1", "statement.pdf"))).rejects.toThrow(
      "Upload a CSV or XLSX statement"
    );
  });

  it("keeps long references and descriptions within their column limits", async () => {
    const [line] = await parse(
      csv(`Date,Amount,Reference,Description\n2026-01-01,1,${"r".repeat(600)},${"d".repeat(1600)}`)
    );
    expect(line.reference).toHaveLength(500);
    expect(line.description).toHaveLength(1500);
  });
});

describe("XLSX statements", () => {
  async function xlsx(rows: unknown[][], withSheet = true) {
    const book = new ExcelJS.Workbook();
    if (withSheet) book.addWorksheet("Statement").addRows(rows);
    return { buffer: Buffer.from(await book.xlsx.writeBuffer()), originalname: "Statement.XLSX" };
  }

  it("reads the first sheet with the same columns", async () => {
    const lines = await parse(
      await xlsx([
        ["Date", "Description", "Amount"],
        ["2026-03-01", "Transfer", 42.5],
      ])
    );

    expect(lines).toEqual([expect.objectContaining({ transactionDate: "2026-03-01", signedAmount: "42.500000" })]);
  });

  it("rejects a workbook without worksheets", async () => {
    await expect(parse(await xlsx([], false))).rejects.toThrow(/no worksheets|1 to 5,000/);
  });
});
