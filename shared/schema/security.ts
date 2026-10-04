import { pgTable, serial, varchar, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies } from "./common";
import { users } from "./users";

export const userSecurityPermissions = pgTable(
  "user_security_permissions",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    permission: text("permission").notNull(),
    grantedBy: varchar("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserCompanyPermission: uniqueIndex("user_security_permissions_unique").on(
      table.userId,
      table.companyId,
      table.permission
    ),
    companyUserIdx: index("user_security_permissions_company_user_idx").on(table.companyId, table.userId),
  })
);

export const userCredentialVersions = pgTable("user_credential_versions", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialVersion: integer("credential_version").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSecurityPermissionSchema = createInsertSchema(userSecurityPermissions)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    userId: z.string().min(1),
    companyId: z.number().int().positive(),
    permission: z.string().trim().min(3).max(200),
    grantedBy: z.string().nullable().optional(),
  });

export type UserSecurityPermission = typeof userSecurityPermissions.$inferSelect;
export type InsertUserSecurityPermission = z.infer<typeof insertUserSecurityPermissionSchema>;
export type UserCredentialVersion = typeof userCredentialVersions.$inferSelect;
