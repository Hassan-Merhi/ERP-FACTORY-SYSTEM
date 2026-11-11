/**
 * Phase 5 full-catalog comparison against an independently reviewed reference.
 * Metadata only: table/column/index/constraint/trigger/function/policy definitions.
 * Never captures rows, secrets, SQL query samples or financial amounts.
 *
 * An approved baseline must be collected from a trusted, restored reference DB.
 * Taking a fingerprint of the same unverified database and declaring it healthy
 * is NOT certification.
 */
import { createHash } from "node:crypto";
const sha=x=>createHash("sha256").update(x).digest("hex");
 const objectKey=(...x)=>x.join(".");
const stableJson=value=>JSON.stringify(value);
const clean=(x,keys)=>Object.fromEntries(keys.map(key=>[key,x[key]??null]));

export function fingerprintFullSchema(snapshot) {
  const groups={
    tables:(snapshot.tables||[]).map(name=>({name})),
    relations:(snapshot.relations||[]).map(x=>({
      name:x.relation_name,
      data:clean(x,["relation_kind","persistence"])
    })),
    views:(snapshot.views||[]).map(x=>({
      name:x.view_name,
      data:clean(x,["view_kind","definition"])
    })),
    sequences:(snapshot.sequences||[]).map(x=>({
      name:x.sequence_name,
      data:clean(x,["data_type","start_value","min_value","max_value","increment_by","cycle","cache_size"])
    })),
    columns:(snapshot.columns||[]).map(x=>({
      name:objectKey(x.table_name,x.column_name),
      data:clean(x,["data_type","not_null","default_expression","identity_generation","generation_expression"])
    })),
    indexes:(snapshot.indexes||[]).map(x=>({
      name:objectKey(x.table_name,x.index_name),
      data:clean(x,["valid","ready","unique","definition","predicate","key_columns"])
    })),
    constraints:(snapshot.constraints||[]).map(x=>({
      name:objectKey(x.table_name,x.constraint_name),
      data:clean(x,["validated","type","definition"])
    })),
    triggers:(snapshot.triggers||[]).map(x=>({
      name:objectKey(x.table_name,x.trigger_name),
      data:clean(x,["enabled","definition"])
    })),
    functions:(snapshot.functions||[]).map(x=>({
      name:objectKey(x.function_name,x.identity_arguments??""),
      data:clean(x,["definition"])
    })),
    policies:(snapshot.policies||[]).map(x=>({
      name:objectKey(x.table_name,x.policy_name??"<no-policy>"),
      data:clean(x,["enabled","forced","policy_name","permissive","policy_command","roles","using_expression","check_expression"])
    }))
  };
  const objects={};
  for(const [group,rows] of Object.entries(groups)) {
    objects[group]=Object.create(null);
    for(const row of rows) {
      if(Object.hasOwn(objects[group],row.name))
        throw new Error("Nonunique schema catalog identity: "+group+":"+row.name);
      objects[group][row.name]=sha(stableJson(row.data??{}));
    }
  }
  return {formatVersion:1,coverage:"full-public-schema-catalog",objects};
}
export function compareFullSchemaFingerprint(reference,current) {
  if(reference?.formatVersion!==1 || current?.formatVersion!==1 ||
     reference?.coverage!=="full-public-schema-catalog" ||
     current?.coverage!=="full-public-schema-catalog") {
    return {ok:false,blockers:["invalid-reference-format"],warnings:[]};
  }
  const blockers=[];
  const groups=["tables","relations","views","sequences","columns","indexes","constraints","triggers","functions","policies"];
  for(const group of groups) {
    const want=reference.objects?.[group];
    const actual=current.objects?.[group];
    if(!want || !actual || Array.isArray(want) || Array.isArray(actual)) {
      blockers.push("invalid-reference-group:"+group);continue;
    }
    for(const [name,hash] of Object.entries(want)) {
      if(!Object.hasOwn(actual,name)) blockers.push("missing:"+group+":"+name);
      else if(actual[name]!==hash) blockers.push("changed:"+group+":"+name);
    }
    for(const name of Object.keys(actual)) {
      if(!Object.hasOwn(want,name)) blockers.push("unexpected:"+group+":"+name);
    }
  }
  return {
    ok:blockers.length===0,blockers,warnings:[],
    note:"Full reference compares PostgreSQL catalog metadata; same-major-version reviewed baseline and production-like staging parity are still required."
  };
}
