import { describe, expect, it } from "vitest";

import { hasIndex, hasTable } from "./helpers/schemaManifest";

// The delivery-tracking tables used to be applied at boot
// (startup-schema/030 via ensureScheduledWhatsAppDeliveryTrackingSchema, which
// aborted startup when they were missing). Migrations now define them and the
// read-only startup schema gate refuses to start without them.
describe("scheduled WhatsApp delivery tracking schema", () => {
  it("migrations define the tracking tables and their lookup indexes", () => {
    expect(hasTable("scheduled_whatsapp_occurrences")).toBe(true);
    expect(hasTable("scheduled_whatsapp_attachments")).toBe(true);
    expect(hasIndex("scheduled_whatsapp_occurrences_retry_idx")).toBe(true);
    expect(hasIndex("scheduled_whatsapp_occurrences_recipient_idx")).toBe(true);
    expect(hasIndex("scheduled_whatsapp_attachments_status_idx")).toBe(true);
  });
});
