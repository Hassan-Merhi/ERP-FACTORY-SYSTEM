import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";

/** Open the pool's first connections before the boot sequence needs them. */
export async function warmupDb() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query("SELECT 1");
      logger.info(`✓ DB connection pool warmed up (attempt ${attempt})`);
      return;
    } catch (err: unknown) {
      logger.warn(`⚠️  DB warmup attempt ${attempt} failed: ${getErrorMessage(err)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  logger.error("✗ DB warmup failed after 3 attempts — queries will connect lazily");
}
