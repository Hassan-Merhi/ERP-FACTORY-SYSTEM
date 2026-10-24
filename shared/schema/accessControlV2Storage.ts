/** Phase 2 V2 permissions persistence. Not read by legacy authorization. */
import {
  pgTable, bigserial, bigint, integer, varchar, text, boolean,
  timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { companies } from "./common";
import { users } from "./users";

export const accessRoleTemplates = pgTable("access_role_templates", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  roleKey: text("role_key").notNull(),
  displayName: text("display_name").notNull(),
  systemManaged: boolean("system_managed").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyRoleUnique: uniqueIndex("access_role_templates_company_id_role_key_key").on(t.companyId, t.roleKey),
  companyIdIdUnique: uniqueIndex("access_role_templates_company_id_id_key").on(t.companyId, t.id),
}));

export const accessRoleRules = pgTable("access_role_rules", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  roleId: bigint("role_id", { mode: "number" }).notNull(),
  resourceKey: text("resource_key").notNull(),
  actionKey: text("action_key").notNull(),
  decision: text("decision").notNull(),
  updatedBy: varchar("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyRoleIdx: index("access_role_rules_company_role_idx").on(t.companyId, t.roleId),
  ruleUnique: uniqueIndex("access_role_rules_company_id_role_id_resource_key_action_key_key").on(t.companyId, t.roleId, t.resourceKey, t.actionKey),
}));

export const accessUserOverrides = pgTable("access_user_overrides", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  resourceKey: text("resource_key").notNull(),
  actionKey: text("action_key").notNull(),
  decision: text("decision").notNull(),
  updatedBy: varchar("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyUserIdx: index("access_user_overrides_company_user_idx").on(t.companyId, t.userId),
  overrideUnique: uniqueIndex("access_user_overrides_company_id_user_id_resource_key_action_key_key").on(t.companyId, t.userId, t.resourceKey, t.actionKey),
}));

export const accessPolicyVersions = pgTable("access_policy_versions", {
  companyId: integer("company_id").primaryKey().references(() => companies.id, { onDelete: "restrict" }),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  mode: text("mode").notNull().default("shadow"),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accessPolicyChangeAudit = pgTable("access_policy_change_audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  revision: bigint("revision", { mode: "number" }).notNull(),
  actorId: varchar("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  beforeRules: jsonb("before_rules").notNull(),
  afterRules: jsonb("after_rules").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyCreatedIdx: index("access_policy_change_audit_company_created_idx").on(t.companyId, t.createdAt),
  revisionUnique: uniqueIndex("access_policy_change_audit_company_id_revision_key").on(t.companyId, t.revision),
}));
