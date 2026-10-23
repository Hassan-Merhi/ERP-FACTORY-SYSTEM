import type { Express } from "express";
import { RENTAL_MODULE_ACCOUNTS } from "../services/accounting/unifiedAccountingFoundation";
import { registerRentalRoutes } from "./rentalRouteFactory";

export function registerErpRentalRoutes(app: Express) {
  const { income, expense } = RENTAL_MODULE_ACCOUNTS.ERP;
  registerRentalRoutes(app, "ERP", "/api/erp/rental", income, expense);
}
