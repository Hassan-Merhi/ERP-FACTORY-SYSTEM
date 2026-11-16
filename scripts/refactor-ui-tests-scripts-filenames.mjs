#!/usr/bin/env node
// Phase 3 filename rewrite; dry-run by default, --apply for changes.
// No production calls. All names are validated for collisions before writes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const root=path.resolve(import.meta.dirname,"..");
const apply=process.argv.includes("--apply");
const files=execFileSync("git",["ls-files","-z"],{cwd:root,encoding:"utf8",maxBuffer:33554432}).split("\0").filter(Boolean);
const all=new Set(files);
const marker=/(?:[Ww]ave|[Pp]hase)[-_ ]?\d+(?:[a-z](?=[A-Z._-]|$))?/g;
const qualifies=p=>/^(?:client\/|tests\/|scripts\/|build\/)/.test(p)&&/(?:wave|phase)[-_ ]?\d+/i.test(path.posix.basename(p))&&!p.startsWith("scripts/repairs/");
const candidates=files.filter(qualifies);
const overrides={
"tests/retail-company-type-contract.test.ts":"tests/retail-company-type-contract.test.ts",
"tests/retail-pos-money-contract.test.ts":"tests/retail-pos-money-contract.test.ts",
"scripts/verify-observability-disaster-recovery.mjs":"scripts/verify-observability-disaster-recovery.mjs",
"tests/weekly-bale-export-helpers.test.ts":"tests/weekly-bale-export-helpers.test.ts",
"tests/purchase-order-items-update.test.ts":"tests/purchase-order-items-update.test.ts",
"tests/multi-domain-route-safety-guards.test.ts":"tests/multi-domain-route-safety-guards.test.ts",
"tests/factory-stock-schema-and-repair-safety.test.ts":"tests/factory-stock-schema-and-repair-safety.test.ts",
"tests/stock-allocation-contract.test.ts":"tests/stock-allocation-contract.test.ts",
"tests/stock-transfer-analysis.test.ts":"tests/stock-transfer-analysis.test.ts",
"tests/stock-transfer-drafts.test.ts":"tests/stock-transfer-drafts.test.ts",
"tests/post-offload-charge-contract.test.ts":"tests/post-offload-charge-contract.test.ts",
"tests/remote-support-observability.test.ts":"tests/remote-support-observability.test.ts",
"tests/factory-pos-commission.test.ts":"tests/factory-pos-commission.test.ts",

"client/src/i18n/retailWave1Translations.ts":"client/src/i18n/retailCatalogTranslations.ts",
"client/src/i18n/retailWave2Translations.ts":"client/src/i18n/retailPosPricingTranslations.ts",
"client/src/i18n/retailWave3Translations.ts":"client/src/i18n/retailAnalyticsTranslations.ts",
"client/src/i18n/remoteSupportPhase4Translations.ts":"client/src/i18n/remoteSupportSessionTranslations.ts",
"client/src/i18n/remoteSupportPhase5Translations.ts":"client/src/i18n/remoteSupportMouseTranslations.ts",
"client/src/i18n/remoteSupportPhase6Translations.ts":"client/src/i18n/remoteSupportKeyboardTranslations.ts",
"scripts/verify-mobile-responsive-foundation-browser.mjs":"scripts/verify-mobile-responsive-foundation-browser.mjs",
"scripts/verify-mobile-responsive-factory-browser.mjs":"scripts/verify-mobile-responsive-factory-browser.mjs",
"scripts/verify-mobile-responsive-erp-browser.mjs":"scripts/verify-mobile-responsive-erp-browser.mjs",
"scripts/verify-mobile-responsive-regression-browser.mjs":"scripts/verify-mobile-responsive-regression-browser.mjs",
"scripts/verify-mobile-responsive-visual-regression.mjs":"scripts/verify-mobile-responsive-visual-regression.mjs",
"scripts/verify-mobile-responsive-release-regression.mjs":"scripts/verify-mobile-responsive-release-regression.mjs",
"client/src/styles/factory-unified-theme-visual-contract.test.ts":"client/src/styles/factory-unified-theme-visual-contract.test.ts",
"tests/factory-edge-write-fence-policy.test.ts":"tests/factory-edge-write-fence-policy.test.ts"
};
function strip(p) {
 const parts=p.split("/");
 let b=parts.pop().replace(marker,"").replace(/--+/g,"-").replace(/__+/g,"_").replace(/-+\./g,".").replace(/_+\./g,".").replace(/^[-_]+/,"");
 if(/^[A-Z]/.test(b))b=b.charAt(0).toLowerCase()+b.slice(1);
 return parts.join("/")+"/"+b;
}
const plan=new Map(candidates.map(p=>[p,overrides[p]||strip(p)]));
const groups=new Map();
for(const [old,target] of plan)groups.set(target,[...(groups.get(target)||[]),old]);
let collisionGroups=0;
for(const [target,sources] of groups) {
 if(sources.length===1&&!all.has(target))continue;
 collisionGroups++;
 for(const old of sources) {
   if(overrides[old])continue;
   if(!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(old))throw Error("Semantic override required for "+old+" -> "+target);
   const text=fs.readFileSync(path.join(root,old),"utf8");
   const titles=[...text.matchAll(/(?:describe|it|test)\s*\(\s*["']([^"']{3,120})["']/g)].map(x=>x[1]);
   let description=(titles.find(x=>!/(?:wave|phase)\s*\d+/i.test(x))||titles[0]||"").replace(marker,"");
   const feature=path.posix.basename(old).replace(marker,"").split(/[^a-z0-9]+/i).filter(Boolean).map(x=>x.toLowerCase());
   description=description.toLowerCase().replace(/[^a-z0-9]+/g,"-").split("-").filter(w=>w&&!feature.includes(w)).slice(0,6).join("-").slice(0,55).replace(/-$/,"");
   if(!description)description="contract-"+crypto.createHash("sha256").update(old).digest("hex").slice(0,7);
   const renamed=target.replace(/(\.(?:test|spec)\.[cm]?[jt]sx?)$/,"-"+description+"$1");
   plan.set(old,renamed);
 }
}
const seen=new Set();
for(const [old,target] of plan) {
 if(seen.has(target)||all.has(target)||target===old)throw Error("Ambiguous or occupied destination: "+old+" -> "+target);
 seen.add(target);
}
const baseMap=new Map();
for(const [from,to] of plan){
 const a=path.posix.basename(from),b=path.posix.basename(to);
 const prev=baseMap.get(a);baseMap.set(a,prev&&prev!==b?null:b);
}
const rules=[...plan].sort((a,b)=>b[0].length-a[0].length);
const escapeRx=s=>s.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&");
const editable=p=>/\.(?:[cm]?[jt]sx?|json|ya?ml|md|sh)$/.test(p)&&!p.startsWith(".github/")&&!p.startsWith("docs/archive/")&&!p.startsWith("docs/superpowers/")&&!p.startsWith("migrations/")&&!p.startsWith("scripts/repairs/")&&!p.endsWith("package-lock.json")&&!p.startsWith("docs/audits/");
const edits=new Map();
for(const p of files.filter(editable)){
 let orig;try{orig=fs.readFileSync(path.join(root,p),"utf8")}catch{continue}
 let next=orig;
 for(const [from,to] of rules) {
  next=next.split(from).join(to);
  const a=path.posix.basename(from),b=path.posix.basename(to);
  if(baseMap.get(a)!==b)continue;
  const oldStem=a.replace(/\.[^.]+$/,""),newStem=b.replace(/\.[^.]+$/,"");
  next=next.replace(new RegExp("(/)"+escapeRx(oldStem)+"(?=[.\\x22\\x27/]|$)","g"),(_m,slash)=>slash+newStem);
 }
 if(orig!==next)edits.set(p,next);
}
const report={mode:apply?"apply":"dry-run",candidateCount:plan.size,collisionGroups,referenceFiles:edits.size,renames:[...plan].map(([from,to])=>({from,to})),referencingFiles:[...edits.keys()]};
console.log(JSON.stringify(report,null,2));
if(!apply)process.exit(0);
for(const [p,text] of edits)fs.writeFileSync(path.join(root,p),text,"utf8");
for(const [from,to] of plan){
 fs.mkdirSync(path.dirname(path.join(root,to)),{recursive:true});
 fs.renameSync(path.join(root,from),path.join(root,to));
}
