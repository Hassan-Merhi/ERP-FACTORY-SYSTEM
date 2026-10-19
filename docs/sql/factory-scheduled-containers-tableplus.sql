-- Run on the ERP + Factory System PostgreSQL database in TablePlus.
-- Independent of factory_shipping_availability.
CREATE TABLE IF NOT EXISTS factory_scheduled_containers (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    date DATE NOT NULL,
    shipping_company TEXT NOT NULL,
    scheduled_containers INTEGER NOT NULL DEFAULT 0
        CHECK (scheduled_containers >= 0),
    note TEXT,
    details TEXT,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fsc_company_date_idx
    ON factory_scheduled_containers (company_id, date);
