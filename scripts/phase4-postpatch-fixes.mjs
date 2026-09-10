import fs from "node:fs";

function replaceOne(path, before, after, label) {
  const source = fs.readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(before, after));
}

replaceOne(
  "tests/proforma-capacity-phase4-reconciliation.test.ts",
  'import { pool } from "../server/db";',
  'import { db, pool } from "../server/db";',
  "phase4 test db import"
);
replaceOne(
  "tests/proforma-capacity-phase4-reconciliation.test.ts",
  "await syncProformaReservations(ctx.db, ctx.companyId, proformaId);",
  "await syncProformaReservations(db, ctx.companyId, proformaId);",
  "phase4 test db usage"
);
