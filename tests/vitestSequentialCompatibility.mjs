import { describe } from "vitest";

// Vitest 5 removed describe.sequential(). Backend suites in this repository
// already run serially (fileParallelism=false), and ordinary describe() is
// sequential by default. Preserve the old spelling while those historical
// coverage suites are migrated without preventing them from being collected.
if (typeof describe.sequential !== "function") {
  describe.sequential = describe;
}
