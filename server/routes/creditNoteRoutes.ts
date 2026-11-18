import type { Express } from "express";
import { registerCreditNoteRoutesPart1 } from "./registerCreditNoteRoutesPart1";
import { registerCreditNoteRoutesPart2 } from "./registerCreditNoteRoutesPart2";
import { registerCreditNoteRoutesPart3 } from "./registerCreditNoteRoutesPart3";

export function registerCreditNoteRoutes(app: Express) {
  registerCreditNoteRoutesPart1(app);
  registerCreditNoteRoutesPart2(app);
  registerCreditNoteRoutesPart3(app);
}
