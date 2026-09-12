import supertest from "supertest";
import { afterEach } from "vitest";
import { pool } from "../server/db";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GENERATED_KEY = Symbol("generatedVoucherRequestIdentity");
let requestSequence = 0;

try {
  const { default: superagent } = await import("superagent");
  superagent.parse[XLSX_MIME] = (response, callback) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
    response.on("error", (error) => callback(error));
  };
} catch {
  // superagent is only present in the test dependency graph.
}

function hasClientRequestId(data) {
  return (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof data.clientRequestId === "string" &&
    data.clientRequestId.trim().length > 0
  );
}

function ensureVoucherRequestIdentity(request) {
  const method = String(request.method || "").toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method) || request[GENERATED_KEY]) return;
  const existingHeader = request.get?.("X-Idempotency-Key");
  if (existingHeader || hasClientRequestId(request._data)) return;
  const generatedKey = `backend-test-${process.pid}-${Date.now()}-${requestSequence++}`;
  request.set("X-Idempotency-Key", generatedKey);
  request[GENERATED_KEY] = generatedKey;
}

async function cleanupGeneratedRequestIdentity(request) {
  const generatedKey = request[GENERATED_KEY];
  if (!generatedKey) return;
  request[GENERATED_KEY] = null;
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return;
  try {
    await pool.query("DELETE FROM accounting_posting_requests WHERE idempotency_key = $1", [generatedKey]);
  } catch {}
}

afterEach(async () => {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return;
  try {
    await pool.query(
      "DELETE FROM accounting_posting_requests WHERE source_type IS DISTINCT FROM $1 AND source_type IS DISTINCT FROM $2",
      ["phase3-test-writer", "phase2-test"]
    );
  } catch {}
});

const requestPrototype = supertest.Test.prototype;
const originalEnd = requestPrototype.end;
const originalThen = requestPrototype.then;

requestPrototype.end = function endWithVoucherRequestIdentity(callback) {
  ensureVoucherRequestIdentity(this);
  if (typeof callback !== "function") return originalEnd.call(this, callback);
  return originalEnd.call(this, (error, response) => {
    void cleanupGeneratedRequestIdentity(this)
      .then(() => callback(error, response))
      .catch((cleanupError) => callback(error ?? cleanupError, response));
  });
};

requestPrototype.then = function thenWithVoucherRequestIdentity(onFulfilled, onRejected) {
  ensureVoucherRequestIdentity(this);
  return originalThen.call(
    this,
    async (response) => {
      await cleanupGeneratedRequestIdentity(this);
      return typeof onFulfilled === "function" ? onFulfilled(response) : response;
    },
    async (error) => {
      try {
        await cleanupGeneratedRequestIdentity(this);
      } catch (cleanupError) {
        if (!error) throw cleanupError;
      }
      if (typeof onRejected === "function") return onRejected(error);
      throw error;
    }
  );
};