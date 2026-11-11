import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeDatabasePerformance } from "../scripts/database-performance-core.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

test("summary handles empty catalog and no query stats",()=>{
  const result=summarizeDatabasePerformance({});
  assert.equal(result.mode,"read-only");
  assert.equal(result.observation.pgStatStatementsAvailable,false);
  assert.deepEqual(result.findings.tables,[]);
  assert.deepEqual(result.findings.indexes,[]);
});
test("large sequential scan workload is a candidate, not automatic index advice",()=>{
  const result=summarizeDatabasePerformance({tables:[
    {relation:"voucher_entries",seq_scans:"120",index_scans:"3",seq_rows:"3000000",live_rows:"300000",dead_rows:"0"},
    {relation:"small_lookup",seq_scans:"10",index_scans:"0",seq_rows:"150",live_rows:"10",dead_rows:"0"}
  ]});
  assert.equal(result.findings.tables.length,1);
  assert.equal(result.findings.tables[0].kind,"sequential-scan-candidate");
  assert.match(result.findings.tables[0].note,/EXPLAIN/);
  assert.equal(result.measuredAgainstLoad,false);
});
test("never recommends dropping unique, primary or constraint-backed indexes",()=>{
  const result=summarizeDatabasePerformance({indexes:[
    {relation:"vouchers",index:"vouchers_pkey",scans:"0",bytes:String(40*1024*1024),primary:true,unique:true,constraintBacked:true},
    {relation:"vouchers",index:"vouchers_company_unique",scans:"0",bytes:String(40*1024*1024),primary:false,unique:true,constraintBacked:false},
    {relation:"vouchers",index:"vouchers_unreviewed_idx",scans:"0",bytes:String(40*1024*1024),primary:false,unique:false,constraintBacked:false}
  ]});
  assert.deepEqual(result.findings.indexes.map(x=>x.index),["vouchers_unreviewed_idx"]);
  assert.match(result.findings.indexes[0].note,/Never auto-drop/);
});
test("dead tuple pressure and waiting locks are surfaced",()=>{
  const result=summarizeDatabasePerformance({
    tables:[{relation:"factory_bales",seq_scans:"0",index_scans:"1",seq_rows:"0",live_rows:"10000",dead_rows:"4000"}],
    activity:[{wait_event_type:"Lock",xact_seconds:"70.4"},{wait_event_type:"Client",xact_seconds:"8"}]
  });
  assert.equal(result.observation.waitingConnections,1);
  assert.equal(result.observation.longestTransactionSeconds,70.4);
  assert.equal(result.findings.tables[0].kind,"dead-tuples-pressure");
});
test("database collector remains read-only and avoids query text",()=>{
  const code=readFileSync(path.join(root,"scripts/audit-database-performance.mjs"),"utf8");
  assert.match(code,/BEGIN READ ONLY/);
  assert.match(code,/ROLLBACK/);
  assert.doesNotMatch(code,/SELECT\s+query\s+FROM\s+pg_stat_statements/i);
  assert.doesNotMatch(code,/CREATE\s+INDEX\s+|DROP\s+INDEX\s+/i);
});
