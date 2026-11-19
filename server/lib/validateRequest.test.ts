import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  VALIDATED_LOCATIONS,
  assertStrictSchema,
  emptyBody,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "./validateRequest";

const updateInput = {
  params: idParams,
  query: z.strictObject({ dryRun: z.enum(["true", "false"]).optional() }),
  body: z.strictObject({
    name: z.string().min(1),
    amount: z.number().positive(),
    lines: z.array(z.strictObject({ sku: z.string() })).optional(),
  }),
} satisfies RequestSchemas;

function appWith(schemas: RequestSchemas, path = "/things/:id") {
  const app = express();
  app.use(express.json());
  app.patch(path, validateRequest(schemas), (req, res) => {
    res.json({ input: validatedInput(req, schemas), body: req.body });
  });
  app.delete(path, validateRequest(schemas), (req, res) => {
    res.json({ input: validatedInput(req, schemas) });
  });
  return app;
}

describe("validateRequest", () => {
  it("passes typed, parsed params, query and body to the handler", async () => {
    const res = await request(appWith(updateInput))
      .patch("/things/42?dryRun=true")
      .send({ name: "Bale", amount: 12.5, lines: [{ sku: "A" }] });
    expect(res.status).toBe(200);
    expect(res.body.input).toEqual({
      params: { id: 42 },
      query: { dryRun: "true" },
      body: { name: "Bale", amount: 12.5, lines: [{ sku: "A" }] },
    });
    expect(res.body.body).toEqual(res.body.input.body);
  });

  it("rejects an unknown body field with a typed 400", async () => {
    const res = await request(appWith(updateInput)).patch("/things/1").send({ name: "x", amount: 1, isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REQUEST_VALIDATION_FAILED");
    expect(res.body.errors).toEqual([expect.objectContaining({ location: "body", code: "unrecognized_keys" })]);
    expect(res.body.message).toMatch(/^Invalid request: body/);
  });

  it("rejects unknown fields in nested objects", async () => {
    const res = await request(appWith(updateInput))
      .patch("/things/1")
      .send({ name: "x", amount: 1, lines: [{ sku: "A", cost: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ location: "body", path: "lines.0", code: "unrecognized_keys" });
  });

  it("rejects unknown query parameters and bad params", async () => {
    const res = await request(appWith(updateInput)).patch("/things/0?force=1").send({ name: "x", amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((issue: { location: string }) => issue.location)).toEqual(["params", "query"]);
  });

  it("reports every failing field, with its path", async () => {
    const res = await request(appWith(updateInput)).patch("/things/3").send({ name: "", amount: -1 });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((issue: { path: string }) => issue.path)).toEqual(["name", "amount"]);
  });

  it("rejects a missing body where one is required", async () => {
    const res = await request(appWith(updateInput)).patch("/things/3");
    expect(res.status).toBe(400);
    expect(res.body.errors[0].location).toBe("body");
  });

  it("emptyBody accepts no body or {} and rejects anything else", async () => {
    const app = appWith({ params: idParams, body: emptyBody });
    expect((await request(app).delete("/things/5")).status).toBe(200);
    expect((await request(app).delete("/things/5").send({})).status).toBe(200);
    expect((await request(app).delete("/things/5").send({ cascade: true })).status).toBe(400);
  });

  it("is named validateRequest so the route manifest records it", () => {
    expect(validateRequest({ params: idParams }).name).toBe("validateRequest");
  });

  it("records which parts it validates", () => {
    const middleware = validateRequest({ params: idParams, body: emptyBody }) as unknown as Record<symbol, unknown>;
    expect(middleware[VALIDATED_LOCATIONS]).toEqual(["params", "body"]);
  });

  it("refuses a declaration with no schemas", () => {
    expect(() => validateRequest({})).toThrow(/at least one/);
  });

  it("validatedInput throws when the middleware did not run", () => {
    expect(() => validatedInput({} as express.Request, updateInput)).toThrow(/did not run/);
  });
});

describe("assertStrictSchema", () => {
  it("accepts strict objects, .strict(), records and scalars", () => {
    expect(() => assertStrictSchema(z.strictObject({ a: z.string() }), "body")).not.toThrow();
    expect(() => assertStrictSchema(z.object({ a: z.string() }).strict(), "body")).not.toThrow();
    expect(() => assertStrictSchema(z.record(z.string(), z.number()), "body")).not.toThrow();
    expect(() => assertStrictSchema(z.array(z.number()), "body")).not.toThrow();
  });

  it("refuses a non-strict object at the top level", () => {
    expect(() => validateRequest({ body: z.object({ a: z.string() }) })).toThrow(/body is a non-strict object/);
  });

  it("refuses passthrough objects", () => {
    expect(() => assertStrictSchema(z.looseObject({ a: z.string() }), "body")).toThrow(/non-strict/);
  });

  it("finds non-strict objects behind wrappers, arrays, unions and records", () => {
    const loose = z.object({ a: z.string() });
    const cases: Array<[z.ZodType, RegExp]> = [
      [z.strictObject({ nested: loose.optional() }), /body\.nested/],
      [z.strictObject({ items: z.array(loose) }), /body\.items\[\]/],
      [z.union([z.strictObject({}), loose]), /body\|1/],
      [z.record(z.string(), loose), /body\{value\}/],
      [z.strictObject({ a: z.string() }).and(loose), /body&right/],
      [loose.nullable().default(null), /body is a non-strict/],
      [loose.transform((value) => value), /body is a non-strict/],
    ];
    for (const [schema, message] of cases) expect(() => assertStrictSchema(schema, "body")).toThrow(message);
  });

  it("terminates on recursive schemas", () => {
    type Node = { children: Node[] };
    const node: z.ZodType<Node> = z.lazy(() => z.strictObject({ children: z.array(node) }));
    expect(() => assertStrictSchema(node, "body")).not.toThrow();
  });
});
