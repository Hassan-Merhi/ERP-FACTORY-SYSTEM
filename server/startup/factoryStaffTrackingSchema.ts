const FACTORY_STAFF_TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS factory_staff_tracking_entries (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    page_type varchar(20) NOT NULL,
    period_type varchar(20) NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    person_type varchar(20) NOT NULL,
    person_id integer NOT NULL,
    category varchar(150),
    target_bales numeric(12, 2),
    produced_bales numeric(12, 2),
    status varchar(20) NOT NULL DEFAULT 'Present',
    notes text,
    created_by integer,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_staff_tracking_page_check CHECK (page_type IN ('production', 'attendance')),
    CONSTRAINT factory_staff_tracking_period_check CHECK (period_type IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT factory_staff_tracking_person_check CHECK (person_type IN ('worker', 'employee')),
    CONSTRAINT factory_staff_tracking_status_check CHECK (status IN ('Present', 'Absent', 'New')),
    CONSTRAINT factory_staff_tracking_period_order_check CHECK (period_end >= period_start),
    CONSTRAINT factory_staff_tracking_target_nonnegative CHECK (target_bales IS NULL OR target_bales >= 0),
    CONSTRAINT factory_staff_tracking_produced_nonnegative CHECK (produced_bales IS NULL OR produced_bales >= 0)
  )
`;

const FACTORY_STAFF_TRACKING_LOCK_SCHEMA_SQL = `
  ALTER TABLE factory_staff_tracking_entries
    ADD COLUMN IF NOT EXISTS group_name varchar(200);

  CREATE TABLE IF NOT EXISTS factory_staff_tracking_period_closures (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    page_type varchar(20) NOT NULL,
    period_type varchar(20) NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    ended_by integer,
    ended_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_staff_tracking_closure_page_check CHECK (page_type IN ('production', 'attendance')),
    CONSTRAINT factory_staff_tracking_closure_period_check CHECK (period_type IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT factory_staff_tracking_closure_period_order_check CHECK (period_end >= period_start),
    CONSTRAINT factory_staff_tracking_closure_unique UNIQUE
      (company_id, page_type, period_type, period_start, period_end)
  )
`;

export const factoryStaffTrackingSchema = [
  FACTORY_STAFF_TRACKING_TABLE_SQL,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_staff_tracking_unique_period_person
   ON factory_staff_tracking_entries
     (company_id, page_type, period_type, period_start, period_end, person_type, person_id)`,
  `CREATE INDEX IF NOT EXISTS factory_staff_tracking_company_period_idx
   ON factory_staff_tracking_entries (company_id, page_type, period_start, period_end)`,
];

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensureFactoryStaffTrackingSchema(database: StartupQueryable): Promise<void> {
  for (const statement of factoryStaffTrackingSchema) {
    await database.query(statement);
  }

  // Keep the pinned startupMigrations array stable while still applying the
  // production-day locking schema on every boot. Production calls this ensure
  // path unconditionally even when the bulk startup migration pass is disabled.
  await database.query(FACTORY_STAFF_TRACKING_LOCK_SCHEMA_SQL);
}
