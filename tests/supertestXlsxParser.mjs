/**
 * Vitest setup: teach supertest's HTTP client (superagent) to hand back XLSX
 * responses as a Buffer instead of mangling them as text.
 *
 * Test-only. It used to live in server/supplierCompanyScopeBridge.mjs, a schema
 * bridge that production also preloaded; schema bridges are gone (migrations own
 * the schema) and production never needed this parser.
 */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const { default: superagent } = await import("superagent");
superagent.parse[XLSX_MIME] = (response, callback) => {
  const chunks = [];
  response.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", (error) => callback(error));
};
