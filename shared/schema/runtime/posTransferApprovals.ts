/**
 * The per-company delegated POS transfer approver and WhatsApp group.
 *
 * Created lazily by runtime DDL in server/routes/posTransferDelegatedApprovalRoutes.ts.
 * Declared here so drizzle-kit and the type system see the real schema; the definition
 * matches the runtime DDL (tests/runtime-declared-tables-ddl.test.ts).
 */
import { foreignKey, integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";
import { companies } from "../common";
import { stockTransferExportWaGroups } from "./whatsappSchedules";
import { users } from "../users";

export const posTransferApprovalSettings = pgTable(
  "pos_transfer_approval_settings",
  {
    companyId: integer("company_id").primaryKey().notNull(),
    userId: varchar("user_id"),
    groupId: integer("group_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "pos_transfer_approval_settings_company_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "pos_transfer_approval_settings_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [stockTransferExportWaGroups.id],
      name: "pos_transfer_approval_settings_group_id_fkey",
    }).onDelete("set null"),
  ]
);
