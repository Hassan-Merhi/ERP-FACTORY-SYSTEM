/** Nullable departure date for the POS Containers OTW view. Existing rows stay blank. */
export const posPortDepartureDateSchema: string[] = [
  "ALTER TABLE containers ADD COLUMN IF NOT EXISTS port_departure_date date",
];
