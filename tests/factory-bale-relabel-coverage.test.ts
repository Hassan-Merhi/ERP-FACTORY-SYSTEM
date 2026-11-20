/**
 * Factory bale relabelling (docs-users/baleRelabelRoutes.ts): validate,
 * apply and history, through the real HTTP app in one rolled-back
 * transaction per test. Pins the request refusals, the per-row validation
 * verdicts, sequential REF allocation from the stored sequence or the highest
 * existing number, the audit session, and that a refused apply changes no
 * bale and writes no audit rows.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const VALIDATE = "/api/factory/bales/relabel/validate";
const APPLY = "/api/factory/bales/relabel/apply";
const SESSIONS = "/api/factory/bales/relabel/sessions";

async function bale(
  w: FactoryWorld,
  reference: string,
  article: string | null = "ART-1",
  product: string | null = "Rags"
) {
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status)
     VALUES ($1, $2, $2, $3, $4, 40, 'IN_STOCK') RETURNING id`,
    [w.companyId, reference, article, product]
  );
}

const refs = (w: FactoryWorld) =>
  w.q<{ reference_number: string }>(`SELECT reference_number FROM factory_bales WHERE company_id = $1 ORDER BY id`, [
    w.companyId,
  ]);

const auditSessions = (w: FactoryWorld) =>
  w.q(`SELECT id FROM bale_recode_sessions WHERE company_id = $1`, [w.companyId]);

describe("bale relabel validation", () => {
  it("refuses empty requests and reports each row's verdict", async () => {
    await withFactoryWorld(async (w) => {
      await bale(w, "OLD-0001");
      await bale(w, "OLD-0002", null, null);
      expect((await w.agent.post(VALIDATE).send({})).status).toBe(400);
      expect((await w.agent.post(VALIDATE).send({ rows: [] })).status).toBe(400);
      const blank = await w.agent.post(VALIDATE).send({ rows: [{ currentRef: "  " }] });
      expect(blank.status).toBe(400);
      expect(blank.body.message).toBe("No reference codes provided");

      const res = await w.agent.post(VALIDATE).send({
        rows: [
          { currentRef: "OLD-0001" },
          { currentRef: "" },
          { currentRef: "OLD-0002" },
          { currentRef: "MISSING-9" },
          { currentRef: "DUP-1" },
          { currentRef: "DUP-1" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.validCount).toBe(2);
      expect(res.body.invalidCount).toBe(4);
      expect(res.body.results).toEqual([
        expect.objectContaining({ currentRef: "OLD-0001", valid: true, productName: "Rags", articleCode: "ART-1" }),
        { currentRef: "", valid: false, error: "Empty reference code" },
        expect.objectContaining({ currentRef: "OLD-0002", valid: true, productName: "Unknown", articleCode: "" }),
        { currentRef: "MISSING-9", valid: false, error: "Not found in inventory" },
        { currentRef: "DUP-1", valid: false, error: "Duplicate in upload" },
        { currentRef: "DUP-1", valid: false, error: "Duplicate in upload" },
      ]);
    });
  });

  it("does not see another company's bales", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}X`]
      );
      await w.q(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status)
         VALUES ($1, 'FOREIGN-1', 'FOREIGN-1', 10, 'IN_STOCK')`,
        [other]
      );
      const res = await w.agent.post(VALIDATE).send({ rows: [{ currentRef: "FOREIGN-1" }] });
      expect(res.body.results[0]).toMatchObject({ valid: false, error: "Not found in inventory" });
      const apply = await w.agent.post(APPLY).send({ rows: [{ currentRef: "FOREIGN-1" }] });
      expect(apply.status).toBe(404);
      expect(apply.body).toEqual({ message: "Bales not found: FOREIGN-1", code: "BALE_RELABEL_NOT_FOUND" });
      const [foreign] = await w.q(`SELECT reference_number FROM factory_bales WHERE company_id = $1`, [other]);
      expect(foreign.reference_number).toBe("FOREIGN-1");
    });
  });
});

describe("bale relabel apply", () => {
  it("refuses empty requests and unknown references without changing anything", async () => {
    await withFactoryWorld(async (w) => {
      await bale(w, "OLD-0001");
      expect((await w.agent.post(APPLY).send({ rows: "x" })).status).toBe(400);
      const none = await w.agent.post(APPLY).send({ rows: [{ currentRef: "" }] });
      expect(none.status).toBe(400);
      expect(none.body.message).toBe("No valid rows to apply");
      const missing = await w.agent.post(APPLY).send({
        rows: ["OLD-0001", "M1", "M2", "M3", "M4", "M5", "M6"].map((currentRef) => ({ currentRef })),
      });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("BALE_RELABEL_NOT_FOUND");
      expect(missing.body.message).toBe("Bales not found: M1, M2, M3, M4, M5 +1 more");
      expect(await refs(w)).toEqual([{ reference_number: "OLD-0001" }]);
      expect(await auditSessions(w)).toEqual([]);
    });
  });

  it("allocates REF numbers from 300000, records the audit and continues the sequence", async () => {
    await withFactoryWorld(async (w) => {
      await bale(w, "OLD-0001");
      await bale(w, "OLD-0002", null, null);
      await w.q(
        `INSERT INTO bale_label_prints (company_id, reference_number, article_code, approx_weight_kg)
         VALUES ($1, 'OLD-0001', 'ART-1', 40)`,
        [w.companyId]
      );
      const first = await w.agent.post(APPLY).send({
        rows: [{ currentRef: "OLD-0001" }, { currentRef: "OLD-0002" }, { currentRef: "" }],
        printFormat: "THERMAL",
        designColor: "blue",
        filename: "relabel.xlsx",
      });
      expect(first.status).toBe(200);
      expect(first.body.items).toEqual([
        { oldRef: "OLD-0001", newRef: "REF300000", productName: "Rags", articleCode: "ART-1", weightKg: "40.000" },
        expect.objectContaining({ oldRef: "OLD-0002", newRef: "REF300001", productName: "Unknown", articleCode: "" }),
      ]);
      expect(await refs(w)).toEqual([{ reference_number: "REF300000" }, { reference_number: "REF300001" }]);
      const [print] = await w.q(`SELECT reference_number FROM bale_label_prints WHERE company_id = $1`, [w.companyId]);
      expect(print.reference_number).toBe("REF300000");
      const [session] = await w.q(
        `SELECT print_format, design_color, uploaded_filename, total_rows, valid_rows, invalid_rows
           FROM bale_recode_sessions WHERE id = $1`,
        [first.body.sessionId]
      );
      expect(session).toEqual({
        print_format: "THERMAL",
        design_color: "blue",
        uploaded_filename: "relabel.xlsx",
        total_rows: 3,
        valid_rows: 2,
        invalid_rows: 1,
      });

      const relabelAgain = await w.agent.post(APPLY).send({ rows: [{ currentRef: "OLD-0001" }] });
      expect(relabelAgain.status).toBe(409);
      expect(relabelAgain.body).toEqual({
        message: "Bales already relabelled: OLD-0001",
        code: "BALE_RELABEL_ALREADY_RELABELLED",
      });
      // A batch mixing a replaced reference with an unknown one is reported as not found.
      const mixed = await w.agent.post(APPLY).send({ rows: [{ currentRef: "OLD-0001" }, { currentRef: "NOPE-1" }] });
      expect(mixed.status).toBe(404);
      expect(mixed.body.message).toBe("Bales not found: NOPE-1");

      const second = await w.agent.post(APPLY).send({ rows: [{ currentRef: "REF300001" }] });
      expect(second.body.items[0].newRef).toBe("REF300002");
      const [seq] = await w.q(`SELECT next_number FROM factory_bale_sequences WHERE company_id = $1`, [w.companyId]);
      expect(Number(seq.next_number)).toBe(300003);

      const history = await w.agent.get(SESSIONS);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(2);
      const items = history.body.flatMap((s: { items: { newReferenceCode: string }[] }) =>
        s.items.map((i) => i.newReferenceCode)
      );
      expect(items.sort()).toEqual(["REF300000", "REF300001", "REF300002"]);
      const latest = history.body.find((s: { id: number }) => s.id === first.body.sessionId);
      expect(latest.printFormat).toBe("THERMAL");
    });
  });

  it("starts above the highest existing numeric reference", async () => {
    await withFactoryWorld(async (w) => {
      await bale(w, "REF450000");
      const res = await w.agent.post(APPLY).send({ rows: [{ currentRef: "REF450000" }] });
      expect(res.body.items[0].newRef).toBe("REF450001");
      expect((await w.agent.get(SESSIONS)).body[0].printFormat).toBe("A4");
    });
  });

  it("refuses a reference repeated in one upload, as validate does, and changes nothing", async () => {
    await withFactoryWorld(async (w) => {
      await bale(w, "OLD-0001");
      await bale(w, "OLD-0002");
      const res = await w.agent.post(APPLY).send({
        rows: [{ currentRef: "OLD-0001" }, { currentRef: "OLD-0002" }, { currentRef: " OLD-0001 " }],
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: "Duplicate in upload: OLD-0001", code: "BALE_RELABEL_DUPLICATE_REF" });
      expect(await refs(w)).toEqual([{ reference_number: "OLD-0001" }, { reference_number: "OLD-0002" }]);
      expect(await auditSessions(w)).toEqual([]);
      const seq = await w.q(`SELECT next_number FROM factory_bale_sequences WHERE company_id = $1`, [w.companyId]);
      expect(seq).toEqual([]);
    });
  });

  it("returns an empty history for a company without sessions", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.get(SESSIONS);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
