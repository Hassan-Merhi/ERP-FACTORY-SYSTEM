import supertest from "supertest";
import { afterEach } from "vitest";
import { pool } from "../server/db";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GENERATED_KEY = Symbol("generatedVoucherRequestIdentity");

let requestSequence = 0;

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
  if (request[GENERATED_KEY]) return request[GENERATED_KEY];

  const method = String(request.method || "").toUpperCase();
  const stateChanging = STATE_CHANGING_METHODS.has(method);
  const existingHeader = request.get?.("X-Idempotency-Key");

  if (!stateChanging || existingHeader || hasClientRequestId(request._data)) {
    return null;
  }

  requestSequence += 1;
  const generatedKey = `vitest-${process.pid}-${requestSequence}`;
  request.set("X-Idempotency-Key", generatedKey);
  request[GENERATED_KEY] = generatedKey;
  return generatedKey;
}

async function cleanupGeneratedRequestIdentity(request) {
  const generatedKey = request[GENERATED_KEY];
  if (!generatedKey) return;

  // Clear the marker before awaiting so callback- and promise-based Supertest
  // completion paths can both call this helper without racing a duplicate
  // cleanup query. Explicit idempotency keys are never stored here and are
  // intentionally preserved for replay assertions within the current test.
  request[GENERATED_KEY] = null;
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return;
  try {
    await pool.query("DELETE FROM accounting_posting_requests WHERE idempotency_key = $1", [generatedKey]);
  } catch {}
}

// The backend test job uses one disposable database for the whole Vitest run.
// Posting identities intentionally block direct voucher deletion in production,
// but legacy route suites physically delete their fixtures between test cases.
// Once a test has completed, its durable request identities are no longer needed
// for same-test replay assertions, so clear them before the next case. The
// dedicated Phase 2 and Phase 3 identity proofs deliberately carry markers
// across test cases and remain excluded explicitly.
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

  if (typeof callback !== "function") {
    return originalEnd.call(this, callback);
  }

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
