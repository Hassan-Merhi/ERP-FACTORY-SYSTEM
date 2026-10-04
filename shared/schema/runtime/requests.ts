/**
 * Idempotency guards, migration bookkeeping and passkeys.
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS in the
 * startup migrations and ensure* services). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match
 * production column for column and the runtime DDL constraint for constraint
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  check,
  bigserial,
  serial,
  text,
  timestamp,
  integer,
  varchar,
  jsonb,
  index,
  foreignKey,
  unique,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "../common";
import { users } from "../users";

export const passkeyCredentials = pgTable(
  "passkey_credentials",
  {
    id: serial().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: bigint({ mode: "number" }).default(0).notNull(),
    deviceName: text("device_name"),
    transports: text().default("[]").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("passkey_credentials_user_id_idx").using("btree", table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "passkey_credentials_user_id_fkey",
    }).onDelete("cascade"),
    unique("passkey_credentials_credential_id_key").on(table.credentialId),
  ]
);

export const voucherPathRequestGuards = pgTable(
  "voucher_path_request_guards",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestKind: text("request_kind").notNull(),
    requestPath: text("request_path").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    state: text().default("processing").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("voucher_path_request_guards_lookup_idx").using("btree", table.companyId, table.idempotencyKey, table.state),
    unique("voucher_path_request_guards_company_key_unique").on(table.companyId, table.idempotencyKey),
    check("voucher_path_request_guards_state_check", sql`state = ANY (ARRAY['processing'::text, 'completed'::text])`),
  ]
);

export const operationalVoucherRequests = pgTable(
  "operational_voucher_requests",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    requestPath: text("request_path").notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    state: varchar({ length: 20 }).default("processing").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("operational_voucher_requests_state_idx").using("btree", table.companyId, table.state, table.createdAt),
    unique("operational_voucher_requests_company_key_unique").on(table.companyId, table.idempotencyKey),
  ]
);

export const financialOperationRequests = pgTable(
  "financial_operation_requests",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    operationName: varchar("operation_name", { length: 160 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    state: varchar({ length: 20 }).default("processing").notNull(),
    resultReference: text("result_reference"),
    resultStatus: integer("result_status"),
    resultBody: jsonb("result_body"),
    errorCode: varchar("error_code", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("financial_operation_requests_lookup_idx").using(
      "btree",
      table.companyId,
      table.operationName,
      table.idempotencyKey,
      table.state
    ),
    index("financial_operation_requests_result_idx")
      .using("btree", table.companyId, table.resultReference)
      .where(sql`(result_reference IS NOT NULL)`),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "financial_operation_requests_company_id_fkey",
    }).onDelete("restrict"),
    unique("financial_operation_requests_company_key_unique").on(
      table.companyId,
      table.operationName,
      table.idempotencyKey
    ),
    check("financial_operation_requests_state_check", sql`state IN ('processing', 'completed', 'failed')`),
  ]
);

export const migrationsLog = pgTable("migrations_log", {
  key: text().primaryKey().notNull(),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
});
