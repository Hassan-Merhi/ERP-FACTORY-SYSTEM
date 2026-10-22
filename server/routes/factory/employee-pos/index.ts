import type { Express } from "express";
import { registerEmployeeCrudRoutes } from "./employee-crud";
import { registerEmployeeAdvancesBonusRoutes } from "./employeeAdvancesBonusRoutes";
import { registerEmployeeLedgerWasteRoutes } from "./employeeLedgerWasteRoutes";
import { registerWasteDispatchBandwidthRoutes } from "./wasteDispatchBandwidthRoutes";
import { registerEmployeePosFinancialRoutes } from "./pos-financial";
import { registerEmployeeNetPositionRoutes } from "./employeeNetPositionRoutes";
import { registerEmployeeAttendanceRoutes } from "./employeeAttendanceRoutes";

export function registerFactoryEmployeesPosRoutes(app: Express) {
  registerEmployeeCrudRoutes(app);
  registerEmployeeAdvancesBonusRoutes(app);
  registerWasteDispatchBandwidthRoutes(app);
  registerEmployeeLedgerWasteRoutes(app);
  registerEmployeePosFinancialRoutes(app);
  registerEmployeeNetPositionRoutes(app);
  registerEmployeeAttendanceRoutes(app);
}
