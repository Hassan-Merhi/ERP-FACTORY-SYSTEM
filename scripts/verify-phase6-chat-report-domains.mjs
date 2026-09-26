import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const resolve = (file) => path.join(root, file);
const read = (file) => fs.readFileSync(resolve(file), "utf8");
const exists = (file) => fs.existsSync(resolve(file));
const lines = (file) => read(file).split(/\r?\n/).length;
const quotedValues = (source) => [...source.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);

const failures = [];
const facade = read("server/chat/reports.ts");
const chatService = read("server/chatService.ts");
const dispatcher = read("server/chat/reports/domains/reportDomainDispatcher.ts");
const domainFactory = read("server/chat/reports/domains/createReportDomainHandler.ts");
const registry = read("server/chat/reports/implementations/reportImplementationRegistry.ts");

if (lines("server/chat/reports.ts") > 30) failures.push("server/chat/reports.ts must remain a thin facade");
if (!facade.includes("dispatchDataQuery")) failures.push("report facade must delegate to the domain dispatcher");
// chatService was decomposed (god-file wave 8): it reaches reports through
// chat/phase1DataQuery.ts, which is the only caller of the stable facade.
const dataQueryGateway = read("server/chat/phase1DataQuery.ts");
if (!chatService.includes('from "./chat/phase1DataQuery"') || !chatService.includes("runPhase1DataQuery(")) {
  failures.push("chatService must route data queries through the phase1 data-query gateway");
}
if (!dataQueryGateway.includes('from "./reports"')) failures.push("chat data-query gateway must use the stable report facade");
if ((dataQueryGateway.match(/runDataQuery/g) || []).length < 2) failures.push("chatService report gateway wiring is missing");
for (const [name, source] of [["chatService", chatService], ["phase1DataQuery", dataQueryGateway]]) {
  if (/switch\s*\(\s*params\.queryType\s*\)/.test(source)) failures.push(`${name} must not own report dispatch logic`);
}
if (!dispatcher.includes("reportDomains")) failures.push("domain registry is missing");
if (!registry.includes("reportImplementationShards")) failures.push("implementation registry is missing");
if (/runLegacyDataQuery|legacyReportEngine/.test(dispatcher + domainFactory + registry)) {
  failures.push("legacy report fallback references must be removed");
}
if (exists("server/chat/reports/legacyReportEngine.ts")) {
  failures.push("legacyReportEngine.ts must be deleted before Phase 6 is complete");
}

const domainDirectory = "server/chat/reports/domains";
const domainFiles = fs
  .readdirSync(resolve(domainDirectory))
  .filter((name) => name.endsWith("ReportDomain.ts") && name !== "createReportDomainHandler.ts")
  .sort();
if (domainFiles.length !== 7) failures.push(`expected seven focused report domains, found ${domainFiles.length}`);

const ownerByQueryType = new Map();
for (const file of domainFiles) {
  const source = read(path.join(domainDirectory, file));
  const ownedArray = source.match(/createReportDomainHandler\("[^"]+",\s*\[([\s\S]*?)\]\);/);
  if (!ownedArray) {
    failures.push(`unable to parse query ownership in ${file}`);
    continue;
  }
  for (const queryType of quotedValues(ownedArray[1])) {
    const existing = ownerByQueryType.get(queryType);
    if (existing) failures.push(`duplicate report ownership for ${queryType}: ${existing}, ${file}`);
    ownerByQueryType.set(queryType, file);
  }
}

const implementationDirectory = "server/chat/reports/implementations";
const shardFiles = fs
  .readdirSync(resolve(implementationDirectory))
  .filter((name) => /^phase\d+ReportShard\.ts$/.test(name))
  .sort();
if (shardFiles.length !== 7) failures.push(`expected seven implementation shards, found ${shardFiles.length}`);

const implementationByQueryType = new Map();
for (const file of shardFiles) {
  const relative = path.join(implementationDirectory, file);
  const source = read(relative);
  if (lines(relative) > 900) failures.push(`${relative} exceeds the 900-line shard boundary`);

  const declaredArray = source.match(/export const phase\d+QueryTypes = \[([\s\S]*?)\] as const;/);
  if (!declaredArray) {
    failures.push(`unable to parse declared query types in ${file}`);
    continue;
  }

  const declared = quotedValues(declaredArray[1]);
  const implemented = [...source.matchAll(/case\s+"([a-z0-9_]+)"\s*:/g)].map((match) => match[1]);
  const declaredSet = new Set(declared);
  const implementedSet = new Set(implemented);

  if (declared.length !== declaredSet.size) failures.push(`${file} declares duplicate query types`);
  if (implemented.length !== implementedSet.size) failures.push(`${file} contains duplicate case implementations`);
  for (const queryType of declaredSet) {
    if (!implementedSet.has(queryType)) failures.push(`${file} declares ${queryType} without an implementation case`);
  }
  for (const queryType of implementedSet) {
    if (!declaredSet.has(queryType)) failures.push(`${file} implements ${queryType} without declaring it`);
  }

  for (const queryType of declared) {
    const existing = implementationByQueryType.get(queryType);
    if (existing) failures.push(`duplicate report implementation for ${queryType}: ${existing}, ${file}`);
    implementationByQueryType.set(queryType, file);
  }
}

for (const [queryType, owner] of ownerByQueryType) {
  if (!implementationByQueryType.has(queryType)) failures.push(`${queryType} is owned by ${owner} but has no implementation`);
}
for (const [queryType, implementation] of implementationByQueryType) {
  if (!ownerByQueryType.has(queryType)) failures.push(`${queryType} is implemented by ${implementation} but has no domain owner`);
}

if (ownerByQueryType.size !== 71) failures.push(`expected 71 owned report query types, found ${ownerByQueryType.size}`);
if (implementationByQueryType.size !== 71) {
  failures.push(`expected 71 implemented report query types, found ${implementationByQueryType.size}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  `Phase 6 chat report domains verified (${ownerByQueryType.size} uniquely owned and implemented query types across ${shardFiles.length} bounded shards).`
);
