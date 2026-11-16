#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";

process.env.API_PAGINATION_DEFAULT_LIMIT = "2";
process.env.API_PAGINATION_MAX_LIMIT = "3";

await import("../server/apiPaginationBridge.mjs");
const expressNamespace = await import("express");
const express = expressNamespace.default || expressNamespace;

const app = express();
const rows = [
  { id: 1, name: "one" },
  { id: 2, name: "two" },
  { id: 3, name: "three" },
  { id: 4, name: "four" },
  { id: 5, name: "five" },
];

app.get("/api/factory/daybook", (_req, res) => res.json(rows));
app.get("/api/stock-items", (_req, res) => res.json(rows));
app.get("/api/factory/bales", (_req, res) =>
  res.json({ items: rows.slice(0, 2), total: rows.length, page: 1, limit: 2, totalPages: 3 })
);
app.get("/api/unrelated", (_req, res) => res.json(rows));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Verifier server did not start");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.ok, true, `${path} should return 200`);
  return { response, body: await response.json() };
}

try {
  const legacy = await get("/api/factory/daybook");
  assert.equal(Array.isArray(legacy.body), true, "Legacy heavy endpoint response must stay an array");
  assert.deepEqual(legacy.body, rows.slice(0, 2));
  assert.equal(legacy.response.headers.get("x-total-count"), "5");
  assert.equal(legacy.response.headers.get("x-default-limit-applied"), "true");

  const firstPage = await get("/api/factory/daybook?pagination=1");
  assert.deepEqual(firstPage.body.items, rows.slice(0, 2));
  assert.deepEqual(
    {
      total: firstPage.body.total,
      page: firstPage.body.page,
      limit: firstPage.body.limit,
      totalPages: firstPage.body.totalPages,
      hasNextPage: firstPage.body.hasNextPage,
      hasPreviousPage: firstPage.body.hasPreviousPage,
    },
    { total: 5, page: 1, limit: 2, totalPages: 3, hasNextPage: true, hasPreviousPage: false }
  );
  assert.equal(firstPage.response.headers.get("x-total-count"), "5");
  assert.equal(firstPage.response.headers.get("x-page-size"), "2");

  const secondPage = await get("/api/factory/daybook?page=2&limit=2");
  assert.deepEqual(secondPage.body.items, rows.slice(2, 4));
  assert.equal(secondPage.body.page, 2);
  assert.equal(secondPage.body.hasPreviousPage, true);

  const offsetPage = await get("/api/stock-items?offset=2&limit=2");
  assert.deepEqual(offsetPage.body.items, rows.slice(2, 4));
  assert.equal(offsetPage.body.page, 2);

  const clamped = await get("/api/stock-items?page=1&limit=9999");
  assert.equal(clamped.body.limit, 3, "Requested limit must be clamped to configured maximum");
  assert.deepEqual(clamped.body.items, rows.slice(0, 3));

  const alreadyPaged = await get("/api/factory/bales?page=1&limit=2");
  assert.equal(Array.isArray(alreadyPaged.body), false);
  assert.deepEqual(alreadyPaged.body.items, rows.slice(0, 2), "Existing paginated objects must not be re-wrapped");

  const unrelated = await get("/api/unrelated?page=1&limit=2");
  assert.equal(Array.isArray(unrelated.body), true, "Unrelated array endpoints must remain untouched");
  assert.deepEqual(unrelated.body, rows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "legacy array shape with safe default limit",
          "default pagination",
          "page and limit pagination",
          "offset pagination",
          "maximum limit clamping",
          "existing pagination preservation",
          "unrelated endpoint isolation",
        ],
      },
      null,
      2
    )
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
