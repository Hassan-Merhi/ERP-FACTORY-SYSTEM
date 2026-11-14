import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p));
const manifest = JSON.parse(read("client/public/manifest.json").toString("utf8"));
const html = read("client/index.html").toString("utf8");
const worker = read("client/public/sw.js").toString("utf8");

assert.equal(manifest.id, "/"); // Preserve existing app identity for upgrades.
assert.equal(manifest.start_url, "/");
assert.equal(manifest.name, "Dakzo Systems");
assert.equal(manifest.short_name, "Dakzo");
const assets = [
  ["dakzo-favicon-v2.png", 48],
  ["dakzo-icon-192-v2.png", 192],
  ["dakzo-icon-512-v2.png", 512],
];
for (const [name, size] of assets) {
  const png = read("client/public/" + name);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", name + " PNG signature");
  assert.equal(png.readUInt32BE(16), size, name + " width");
  assert.equal(png.readUInt32BE(20), size, name + " height");
  assert.ok(html.includes(name) || worker.includes(name), name + " referenced");
  assert.equal(png[25], 3, name + " uses PNG palette");
}
for (const size of [192, 512]) {
  assert.ok(manifest.icons.some((icon) =>
    icon.src === "/dakzo-icon-" + size + "-v2.png" &&
    icon.sizes === size + "x" + size && icon.type === "image/png"
  ), size + " missing from manifest");
}
assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
assert.ok(html.includes("/manifest.json?brand=dakzo-20261114-v2"));
assert.ok(html.includes('media="(prefers-color-scheme: dark)"'));
assert.ok(html.includes('media="(prefers-color-scheme: light)"'));
assert.ok(worker.includes("/dakzo-favicon-v2.png"));
assert.ok(worker.includes("/dakzo-icon-192-v2.png"));
assert.ok(worker.includes("/dakzo-icon-512-v2.png"));
for (const theme of ["dark", "light"]) {
  const svg = read(`client/public/dakzo-mark-${theme}-v2.svg`).toString("utf8");
  assert.match(svg, /<svg/);
  assert.match(svg, /viewBox="0 0 128 128"/);
  assert.ok(worker.includes(`/dakzo-mark-${theme}-v2.svg`));
}
console.log("Dakzo PWA branding assets and manifest verified.");
