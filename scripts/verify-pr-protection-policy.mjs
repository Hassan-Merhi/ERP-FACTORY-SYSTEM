#!/usr/bin/env node

import fs from "node:fs";

const policyPath = "config/pr-protection-policy.json";
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const failures = [];

function read(path) {
  if (!fs.existsSync(path)) {
    failures.push(`Missing required protection-policy file: ${path}`);
    return "";
  }
  return fs.readFileSync(path, "utf8");
}

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

function requirePrTrigger(source, label) {
  if (!/^\s*pull_request:\s*$/m.test(source)) {
    failures.push(`${label}: required PR producer does not declare pull_request`);
  }
}

const required = policy.requiredContexts ?? [];
const postMergeOnly = policy.postMergeOnlyContexts ?? [];
const retired = policy.retiredCompatibilityContexts ?? [];
const producers = policy.producers ?? {};

if (policy.schemaVersion !== 1) failures.push(`Unsupported protection policy schemaVersion: ${policy.schemaVersion}`);
if (policy.targetBranch !== "main") failures.push(`Protection policy targetBranch must be main, got ${policy.targetBranch}`);
if (policy.strictRequiredStatusChecks !== true) failures.push("Protection policy must remain strict.");

const requiredSet = new Set(required);
if (requiredSet.size !== required.length) failures.push("requiredContexts contains duplicates.");

for (const context of [...postMergeOnly, ...retired]) {
  if (requiredSet.has(context)) {
    failures.push(`Context must not be a required PR check: ${context}`);
  }
}

for (const context of required) {
  const workflowPath = producers[context];
  if (!workflowPath) {
    failures.push(`No producer mapped for required context: ${context}`);
    continue;
  }
  const source = read(workflowPath);
  requirePrTrigger(source, workflowPath);
  requireText(source, `name: ${context}`, `${workflowPath} producer for ${context}`);
}

const releaseGovernance = read(".github/workflows/release-governance.yml");
if (/^\s*pull_request:\s*$/m.test(releaseGovernance)) {
  failures.push("Release Governance must stay post-merge/scheduled, not a PR-required producer.");
}
requireText(releaseGovernance, "name: Protect main and release path", "Release Governance");

const mainCertification = read(".github/workflows/main-certification.yml");
if (/^\s*pull_request:\s*$/m.test(mainCertification)) {
  failures.push("Main Certification must certify merged main, not become a PR-required producer.");
}
requireText(mainCertification, "name: Main Certification", "Main Certification");

for (const [path, context] of [
  [".github/workflows/codeql.yml", "Analyze JavaScript / TypeScript"],
  [".github/workflows/semgrep.yml", "Semgrep CE new-findings gate"],
  [".github/workflows/actions-quality.yml", "actionlint"],
  [".github/workflows/actions-quality.yml", "zizmor"],
]) {
  const source = read(path);
  requirePrTrigger(source, path);
  requireText(source, `name: ${context}`, `${path} required-context contract`);
}

if (failures.length > 0) {
  console.error(`PR protection policy verification failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      targetBranch: policy.targetBranch,
      strictRequiredStatusChecks: policy.strictRequiredStatusChecks,
      requiredContexts: required,
      postMergeOnlyContexts: postMergeOnly,
      retiredCompatibilityContexts: retired,
    },
    null,
    2,
  ),
);
