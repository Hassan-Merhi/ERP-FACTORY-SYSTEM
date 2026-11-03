#!/usr/bin/env node
/**
 * Optional factory relay process: immediate first attempt and periodic retries
 * after WAN connectivity returns. Stages evidence; never applies cloud writes.
 * Start only through the explicit Docker Compose "sync" profile.
 */
import { sendVoucherOutboxOnce, readSenderConfiguration } from "./send-voucher-outbox.mjs";

readSenderConfiguration();
let closing = false;
process.on("SIGTERM", () => { closing = true; });
process.on("SIGINT", () => { closing = true; });

async function delay(ms) {
  let remaining = ms;
  while (!closing && remaining > 0) {
    const part = Math.min(1000, remaining);
    await new Promise((resolve) => setTimeout(resolve, part));
    remaining -= part;
  }
}

while (!closing) {
  try {
    const result = await sendVoucherOutboxOnce();
    if (result.staged) console.log(`Factory cloud inbox staged ${result.staged} voucher events; business postings: 0`);
  } catch (error) {
    // No payloads, auth headers, or signing keys are logged.
    console.error("Factory evidence relay retrying after failure:", error instanceof Error ? error.message : "unknown");
  }
  await delay(60_000);
}
