import type { Express } from "express";
import { RENTAL_MODULE_ACCOUNTS } from "../services/accounting/unifiedAccountingFoundation";
import { registerRentalRoutes } from "./rentalRouteFactory";

export function registerFactoryRentalRoutes(app: Express) {
  const { income, expense } = RENTAL_MODULE_ACCOUNTS.FACTORY;
  registerRentalRoutes(app, "FACTORY", "/api/factory/rental", income, expense);
}
