/**
 * Label banner colours and custom banner images over HTTP, one rolled-back
 * transaction per test (label_design_colors is a global table, so every write
 * here disappears on ROLLBACK).
 *
 * Pinned: create (slug derivation, override, validation, duplicate, upload
 * type filter, sort order), patch, delete (built-ins refused), image upload /
 * revert, the public image route (content type, cache headers, fall-through
 * for unknown, non-data-URL and malformed slugs) and the POS role refusal.
 *
 * Observed: the table has no company column, so these colours and images are
 * shared by every company; any signed-in non-POS user of any company can
 * change or delete them.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const COLORS = "/api/factory/label-design-colors";
const BANNERS = "/api/factory/label-banners";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const slugOf = (w: FactoryWorld, suffix: string) => `${w.tag.toLowerCase()}-${suffix}`;

async function create(w: FactoryWorld, fields: Record<string, string>, image?: { buffer: Buffer; type: string }) {
  const req = w.agent.post(COLORS);
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  if (image) req.attach("image", image.buffer, { filename: "banner", contentType: image.type });
  return req;
}

describe("label design colours", () => {
  it("creates colours with derived or overridden slugs and the next sort order", async () => {
    await withFactoryWorld(async (w) => {
      const label = `--${w.tag} Sky  Blue!!--`;
      const derived = await create(w, { label, colorHex: "#3399ff" });
      expect(derived.status).toBe(200);
      expect(derived.body).toMatchObject({
        slug: `${w.tag.toLowerCase()}-sky-blue`,
        label,
        colorHex: "#3399ff",
        isDefault: false,
        hasCustom: false,
        lastModified: null,
      });
      expect(derived.body.imageData).toBeUndefined();

      const withImage = await create(
        w,
        { label: "Override", colorHex: "#000", slug: ` ${slugOf(w, "OVR")} ` },
        { buffer: PNG, type: "image/png" }
      );
      expect(withImage.status).toBe(200);
      expect(withImage.body).toMatchObject({ slug: slugOf(w, "ovr"), hasCustom: true });
      expect(typeof withImage.body.lastModified).toBe("number");
      expect(withImage.body.sortOrder).toBe(derived.body.sortOrder + 1);

      const list = await w.agent.get(COLORS);
      expect(list.status).toBe(200);
      const created = list.body.find((row: { slug: string }) => row.slug === slugOf(w, "ovr"));
      expect(created).toMatchObject({ hasCustom: true });
      expect(created.imageData).toBeUndefined();
      const legacy = await w.agent.get(BANNERS);
      expect(legacy.body).toContainEqual({
        slot: slugOf(w, "ovr"),
        hasCustom: true,
        lastModified: created.lastModified,
      });
    });
  });

  it("refuses missing fields, bad slugs, duplicates and non-image uploads", async () => {
    await withFactoryWorld(async (w) => {
      expect((await create(w, { label: "No colour" })).body).toEqual({ message: "label and colorHex are required" });
      const badSlug = await create(w, { label: "x", colorHex: "#fff", slug: "-bad slug" });
      expect(badSlug.status).toBe(400);
      expect(badSlug.body.message).toMatch(/Invalid slug/);
      const emptyDerived = await create(w, { label: "!!!", colorHex: "#fff" });
      expect(emptyDerived.status).toBe(400);
      const wrongType = await create(
        w,
        { label: "Gif", colorHex: "#fff" },
        { buffer: Buffer.from("GIF89a"), type: "image/gif" }
      );
      expect(wrongType.status).toBe(400);
      expect(wrongType.body.message).toBe("Only JPG, PNG or WEBP images are allowed");

      const slug = slugOf(w, "dup");
      expect((await create(w, { label: "One", colorHex: "#111", slug })).status).toBe(200);
      const duplicate = await create(w, { label: "Two", colorHex: "#222", slug });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.message).toBe(`A color with slug "${slug}" already exists`);
      const [count] = await w.q<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM label_design_colors WHERE slug = $1`,
        [slug]
      );
      expect(count.count).toBe(1);
    });
  });

  it("patches label and colour, refusing empty and unknown updates", async () => {
    await withFactoryWorld(async (w) => {
      const slug = slugOf(w, "patch");
      await create(w, { label: "Before", colorHex: "#111", slug });
      expect((await w.agent.patch(`${COLORS}/${slug}`).send({})).body).toEqual({ message: "Nothing to update" });
      const label = await w.agent.patch(`${COLORS}/${slug}`).send({ label: "After" });
      expect(label.body).toMatchObject({ label: "After", colorHex: "#111", hasCustom: false });
      const hex = await w.agent.patch(`${COLORS}/${slug}`).send({ colorHex: "#999" });
      expect(hex.body).toMatchObject({ label: "After", colorHex: "#999" });
      const missing = await w.agent.patch(`${COLORS}/${slugOf(w, "none")}`).send({ label: "x" });
      expect(missing.status).toBe(404);
    });
  });

  it("deletes custom colours but never built-ins", async () => {
    await withFactoryWorld(async (w) => {
      const slug = slugOf(w, "del");
      await create(w, { label: "Gone", colorHex: "#111", slug });
      expect((await w.agent.delete(`${COLORS}/${slug}`)).body).toEqual({ ok: true });
      expect((await w.agent.delete(`${COLORS}/${slug}`)).status).toBe(404);

      const builtIn = slugOf(w, "builtin");
      await w.q(
        `INSERT INTO label_design_colors (slug, label, color_hex, sort_order, is_default) VALUES ($1, 'Built in', '#000', 0, TRUE)`,
        [builtIn]
      );
      const refused = await w.agent.delete(`${COLORS}/${builtIn}`);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toBe("Built-in colors cannot be deleted");
      expect(await w.q(`SELECT 1 FROM label_design_colors WHERE slug = $1`, [builtIn])).toHaveLength(1);
    });
  });

  it("refuses POS users", async () => {
    await withFactoryWorld(async (w) => {
      const pos = await w.agentFor("POS");
      const res = await pos.post(COLORS).field("label", "Nope").field("colorHex", "#fff");
      expect(res.status).toBe(403);
      expect((await pos.delete(`${BANNERS}/anything`)).status).toBe(403);
    });
  });
});

describe("label banner images", () => {
  it("uploads, serves with cache headers and reverts a banner", async () => {
    await withFactoryWorld(async (w) => {
      const slug = slugOf(w, "img");
      await create(w, { label: "Image", colorHex: "#123", slug });

      const noFile = await w.agent.post(`${BANNERS}/${slug}`).field("note", "x");
      expect(noFile.body).toEqual({ message: "No image uploaded" });
      const badSlug = await w.agent
        .post(`${BANNERS}/Bad_Slug`)
        .attach("image", PNG, { filename: "a.png", contentType: "image/png" });
      expect(badSlug.body).toEqual({ message: "Invalid slug" });
      const wrongType = await w.agent
        .post(`${BANNERS}/${slug}`)
        .attach("image", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" });
      expect(wrongType.status).toBe(400);
      const missing = await w.agent
        .post(`${BANNERS}/${slugOf(w, "missing")}`)
        .attach("image", PNG, { filename: "a.png", contentType: "image/png" });
      expect(missing.status).toBe(404);

      const uploaded = await w.agent
        .post(`${BANNERS}/${slug}`)
        .attach("image", PNG, { filename: "a.png", contentType: "image/png" });
      expect(uploaded.status).toBe(200);
      expect(uploaded.body).toMatchObject({ slot: slug, hasCustom: true });

      const pinned = await w.agent.get(`/labels/hmd-${slug}.jpg`).query({ t: uploaded.body.lastModified });
      expect(pinned.status).toBe(200);
      expect(pinned.headers["content-type"]).toBe("image/png");
      expect(pinned.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(Buffer.compare(pinned.body as Buffer, PNG)).toBe(0);
      const loose = await w.agent.get(`/labels/hmd-${slug}.jpg`);
      expect(loose.headers["cache-control"]).toBe("public, max-age=600");

      const reverted = await w.agent.delete(`${BANNERS}/${slug}`);
      expect(reverted.body).toEqual({ slot: slug, hasCustom: false, lastModified: null });
      const [row] = await w.q(`SELECT image_data FROM label_design_colors WHERE slug = $1`, [slug]);
      expect(row.image_data).toBeNull();
    });
  });

  it("falls through to static serving for unknown, plain and malformed images", async () => {
    await withFactoryWorld(async (w) => {
      const plain = slugOf(w, "plain");
      await w.q(
        `INSERT INTO label_design_colors (slug, label, color_hex, sort_order, image_data) VALUES ($1, 'Plain', '#000', 0, 'not-a-data-url')`,
        [plain]
      );
      for (const path of [
        `/labels/hmd-${plain}.jpg`,
        `/labels/hmd-${slugOf(w, "unknown")}.jpg`,
        "/labels/hmd-UPPER.jpg",
      ]) {
        const res = await w.agent.get(path);
        expect(res.headers["cache-control"] ?? "").not.toMatch(/max-age=600|immutable/);
      }
    });
  });
});
