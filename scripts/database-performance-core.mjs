/**
 * Phase 6 read-only PostgreSQL telemetry classifier.
 * Suggestions are hypotheses until compared with real EXPLAIN plans and output totals.
 */
export function summarizeDatabasePerformance({ tables = [], indexes = [], activity = [], statsAvailable = false, statements = [] } = {}, options = {}) {
  const minSequentialRows = options.minSequentialRows ?? 100000;
  const minScanRatio = options.minScanRatio ?? 20;
  const minUnusedIndexBytes = options.minUnusedIndexBytes ?? 32 * 1024 * 1024;
  const tableFindings = [];
  const indexFindings = [];
  for(const t of tables) {
    const seqScans=Number(t.seq_scans)||0;
    const idxScans=Number(t.index_scans)||0;
    const seqRows=Number(t.seq_rows)||0;
    const live=Number(t.live_rows)||0;
    const dead=Number(t.dead_rows)||0;
    if(seqRows>=minSequentialRows && seqScans>=minScanRatio*Math.max(1,idxScans)) {
      tableFindings.push({
        relation:t.relation,kind:"sequential-scan-candidate",
        seqScans,idxScans,seqRows,liveRowsEstimate:live,
        note:"Requires EXPLAIN and predicates; a sequential scan may be optimal."
      });
    }
    if(live>=10000 && dead/live>0.25) {
      tableFindings.push({
        relation:t.relation,kind:"dead-tuples-pressure",
        deadRowsEstimate:dead,liveRowsEstimate:live,
        note:"Check autovacuum progress, long-running transactions and bloat before tuning."
      });
    }
  }
  for(const i of indexes) {
    const reads=Number(i.scans)||0;
    const bytes=Number(i.bytes)||0;
    if(reads===0 && bytes>=minUnusedIndexBytes && !i.primary && !i.unique && !i.constraintBacked) {
      indexFindings.push({
        relation:i.relation,index:i.index,kind:"large-low-use-index-candidate",
        sizeBytes:bytes,
        note:"Never auto-drop: stats reset, replicas, infrequent workloads and maintenance windows affect usage."
      });
    }
  }
  return {
    mode:"read-only",
    observation:{
      tableCount:tables.length,indexCount:indexes.length,
      activeConnections:activity.length,
      waitingConnections:activity.filter(a=>a.wait_event_type==="Lock").length,
      longestTransactionSeconds:activity.reduce((n,a)=>Math.max(n,Number(a.xact_seconds)||0),0),
      pgStatStatementsAvailable:statsAvailable,
      topStatements:statsAvailable?statements:[]
    },
    findings:{tables:tableFindings,indexes:indexFindings},
    // This is evidence, not a pass/fail certification of real latency.
    measuredAgainstLoad:false
  };
}
