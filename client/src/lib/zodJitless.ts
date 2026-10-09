/**
 * Zod v4 compiles object validators with `new Function` when the page allows
 * it, and probes for that with `Function("")` the first time a schema is
 * built. Under the Content-Security-Policy (script-src 'self', no
 * 'unsafe-eval') that probe is a violation on every page load, and the
 * interpreted validators it falls back to are what we want anyway. Turning
 * JIT off skips the probe. This module must be the first import in main.tsx:
 * schemas read the setting when they are created.
 */
import { z } from "zod";

z.config({ jitless: true });
