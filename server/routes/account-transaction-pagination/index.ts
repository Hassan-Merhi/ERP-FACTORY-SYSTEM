import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { authorizeCompanyIdParam } from "../helpers/supplierBalanceHelpers";
import { getCustomerByLedgerId } from "../../lib/factoryCustomerLedger";
import { bankAccounts, companies, customers, employees, fixedAssets, ledgerAccounts } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { StatementPage } from "./_helpers";
import {
  dateContext,
  exposePaginationHeaders,
  parseContinuousWindow,
  parsePagination,
  wantsPagination,
} from "./_helpers";
import { runVoucherEntryStatement } from "./voucherEntryStatement";
import { runCustomerBalanceStatement } from "./customerBalanceStatement";
import { runFactoryCustomerLedgerStatement } from "./factoryCustomerLedgerStatement";
import { ContinuousCursorError } from "../../lib/continuousCursor";

export function registerAccountTransactionPaginationRoutes(app: Express): void {
  const guard =
    (handler: (req: Request, res: Response) => Promise<Response | void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      if (!wantsPagination(req)) return next();
      try {
        await handler(req, res);
      } catch (error: unknown) {
        if (error instanceof ContinuousCursorError) {
          return res.status(400).json({ message: error.message, code: error.code });
        }
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    };

  const send = (res: Response, page: StatementPage): Response => {
    exposePaginationHeaders(res, page);
    return res.json(page);
  };

  app.get(
    "/api/accounts/ledger/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }
      const [account] = await db
        .select({ companyId: ledgerAccounts.companyId })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), isNull(ledgerAccounts.deletedAt)))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Ledger account not found" });
      if ((await authorizeCompanyIdParam(req, account.companyId)) === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      const pagination = parsePagination(req);
      const continuous = parseContinuousWindow(req);
      const dates = dateContext(req);
      const linkedCustomer = await getCustomerByLedgerId(accountId);
      if (linkedCustomer && linkedCustomer.companyId === account.companyId) {
        const [company] = await db
          .select({ companyType: companies.companyType })
          .from(companies)
          .where(eq(companies.id, linkedCustomer.companyId))
          .limit(1);
        if (company?.companyType === "factory") {
          return send(
            res,
            await runFactoryCustomerLedgerStatement({
              customerId: linkedCustomer.id,
              ledgerAccountId: accountId,
              companyId: linkedCustomer.companyId,
              pagination,
              dates,
              continuous,
            })
          );
        }
      }
      return send(
        res,
        await runVoucherEntryStatement({
          kind: "ledger",
          accountId,
          companyId: account.companyId,
          pagination,
          dates,
          continuous,
        })
      );
    })
  );

  app.get(
    "/api/accounts/bank/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid bank account ID" });
      }
      const [account] = await db
        .select({ companyId: bankAccounts.companyId })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, accountId))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Bank account not found" });
      if ((await authorizeCompanyIdParam(req, account.companyId)) === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }
      return send(
        res,
        await runVoucherEntryStatement({
          kind: "bank",
          accountId,
          companyId: account.companyId,
          pagination: parsePagination(req),
          dates: dateContext(req),
          continuous: parseContinuousWindow(req),
        })
      );
    })
  );

  app.get(
    "/api/accounts/fixed-asset/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid fixed asset ID" });
      }
      const [account] = await db
        .select({ companyId: fixedAssets.companyId })
        .from(fixedAssets)
        .where(eq(fixedAssets.id, accountId))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Fixed asset not found" });
      if ((await authorizeCompanyIdParam(req, account.companyId)) === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }
      return send(
        res,
        await runVoucherEntryStatement({
          kind: "fixed-asset",
          accountId,
          companyId: account.companyId,
          pagination: parsePagination(req),
          dates: dateContext(req),
          continuous: parseContinuousWindow(req),
        })
      );
    })
  );

  app.get(
    "/api/accounts/supplier/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }
      const requestedCompanyId =
        typeof req.query.companyId === "string"
          ? Number.parseInt(req.query.companyId, 10)
          : req.session.currentCompanyId;
      const companyId = await authorizeCompanyIdParam(req, requestedCompanyId);
      if (companyId === null) {
        return res.status(403).json({ message: "No access to this company" });
      }
      const [supplier] = await db
        .select({ id: companyScopedSuppliers.id })
        .from(companyScopedSuppliers)
        .where(
          and(
            eq(companyScopedSuppliers.id, accountId),
            eq(companyScopedSuppliers.companyId, companyId),
            isNull(companyScopedSuppliers.deletedAt)
          )
        )
        .limit(1);
      if (!supplier) return res.status(404).json({ message: "Supplier not found" });
      return send(
        res,
        await runVoucherEntryStatement({
          kind: "supplier",
          accountId,
          companyId,
          pagination: parsePagination(req),
          dates: dateContext(req),
          continuous: parseContinuousWindow(req),
        })
      );
    })
  );

  app.get(
    "/api/accounts/employee/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid employee ID" });
      }
      const [account] = await db
        .select({ companyId: employees.companyId })
        .from(employees)
        .where(eq(employees.id, accountId))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Employee not found" });
      if ((await authorizeCompanyIdParam(req, account.companyId)) === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }
      return send(
        res,
        await runVoucherEntryStatement({
          kind: "employee",
          accountId,
          companyId: account.companyId,
          pagination: parsePagination(req),
          dates: dateContext(req),
          continuous: parseContinuousWindow(req),
        })
      );
    })
  );

  app.get(
    "/api/accounts/customer/:id/transactions",
    requireAuth,
    guard(async (req, res) => {
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }
      const [account] = await db
        .select({ companyId: customers.companyId })
        .from(customers)
        .where(eq(customers.id, accountId))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Customer not found" });
      if ((await authorizeCompanyIdParam(req, account.companyId)) === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }
      return send(
        res,
        await runCustomerBalanceStatement({
          customerId: accountId,
          companyId: account.companyId,
          pagination: parsePagination(req),
          dates: dateContext(req),
          continuous: parseContinuousWindow(req),
        })
      );
    })
  );
}
