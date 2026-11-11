#!/usr/bin/env node
/**
 * Phase 9 release gate: read-only, fail closed.
 * Missing evidence MUST block approval. The gate never executes migrations,
 * modifies PostgreSQL, merges a branch, or deploys to Render.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import { assessReleaseEvidence } from "./database-phase9-release-core.mjs";

async function main() {
  const args=process.argv.slice(2);
  if(args.some(x=>!x.startsWith("--commit=")&&!x.startsWith("--evidence="))) {
    throw new Error("Usage: node scripts/verify-database-phase9-release.mjs --commit=<40-hex-sha> [--evidence=/secure/path.json]");
  }
  const commit=args.find(x=>x.startsWith("--commit="))?.slice(9)||process.env.GITHUB_SHA||"";
  const evidencePath=args.find(x=>x.startsWith("--evidence="))?.slice(11);
  let evidence=null;
  if(evidencePath) {
    evidence=JSON.parse(await readFile(evidencePath,"utf8"));
  }
  const report=assessReleaseEvidence(evidence,{commit});
  console.log(JSON.stringify(report,null,2));
  if(!report.ok) process.exitCode=1;
}
main().catch(error=>{
  console.error("Database Phase 9 release preflight failed:",error instanceof Error?error.message:String(error));
  process.exitCode=2;
});
