import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { scheduledWhatsAppDeliveryTracking } from "../server/startup-schema/030-scheduled-whatsapp-delivery-tracking";
import { ensureScheduledWhatsAppDeliveryTrackingSchema } from "../server/startup/ensureRuntimeSchema";

function poolWithTrackingVerification(present: boolean) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("to_regclass('public.scheduled_whatsapp_occurrences')")) {
      return {
        rows: [
          {
            occurrences_table: present ? "scheduled_whatsapp_occurrences" : null,
            attachments_table: present ? "scheduled_whatsapp_attachments" : null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  return { pool: { query } as unknown as Pool, query };
}

describe("scheduled WhatsApp runtime schema", () => {
  it("applies the tracking DDL even when the bulk startup migration pass is skipped", async () => {
    const { pool, query } = poolWithTrackingVerification(true);

    await ensureScheduledWhatsAppDeliveryTrackingSchema(pool);

    expect(query).toHaveBeenCalledTimes(scheduledWhatsAppDeliveryTracking.length + 1);
    for (const statement of scheduledWhatsAppDeliveryTracking) {
      expect(query).toHaveBeenCalledWith(statement);
    }
  });

  it("fails startup verification when the required tracking tables are still missing", async () => {
    const { pool } = poolWithTrackingVerification(false);

    await expect(ensureScheduledWhatsAppDeliveryTrackingSchema(pool)).rejects.toThrow(
      "Scheduled WhatsApp delivery tracking schema is unavailable after startup repair"
    );
  });
});
