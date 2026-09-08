import { describe, expectTypeOf, it } from "vitest";
import type { Serialized } from "./apiTypes";

interface Row {
  id: number;
  name: string;
  createdAt: Date;
  deletedAt: Date | null;
  amount: string;
  tags: string[];
  history: { at: Date; note: string }[];
}

describe("Serialized", () => {
  it("turns Date fields into the ISO strings JSON.stringify produces", () => {
    expectTypeOf<Serialized<Row>["createdAt"]>().toEqualTypeOf<string>();
  });

  it("preserves nullability alongside the conversion", () => {
    expectTypeOf<Serialized<Row>["deletedAt"]>().toEqualTypeOf<string | null>();
  });

  it("leaves already-serializable fields alone", () => {
    expectTypeOf<Serialized<Row>["id"]>().toEqualTypeOf<number>();
    expectTypeOf<Serialized<Row>["amount"]>().toEqualTypeOf<string>();
    expectTypeOf<Serialized<Row>["tags"]>().toEqualTypeOf<string[]>();
  });

  it("recurses through arrays of objects", () => {
    expectTypeOf<Serialized<Row>["history"][number]["at"]>().toEqualTypeOf<string>();
    expectTypeOf<Serialized<Row>["history"][number]["note"]>().toEqualTypeOf<string>();
  });
});
