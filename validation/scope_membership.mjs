// Record-level replay membership for scope/pool reconciliation.
//
// Reads normalized SPEDIA events (JSONL produced by the unchanged adapter) and,
// for every event, records which clean-policy requirements it falls under and
// whether it is exposed under each policy variant and semantics. The per-event
// logic mirrors scoreEvents() in experiments/run-spedia-replay.js (that
// function is not exported) and uses the same exported clauseMatches,
// evaluatePolicy and ACTION_SEVERITY. Aggregates are checked against
// results/spedia_replay_summary.csv by the Python caller.
//
// Usage: node validation/scope_membership.mjs <events.jsonl> <out.json>

import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { clauseMatches, evaluatePolicy } from "../src/evaluator.js";
import { ACTION_SEVERITY } from "../src/schema.js";
import { buildSpediaPolicies } from "../experiments/spedia-policy.js";

const [input, output] = process.argv.slice(2);
const variants = buildSpediaPolicies();
const records = [];

const lines = createInterface({ input: createReadStream(input, "utf8"), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  const entry = { event_id: event.event_id, requirements: {}, exposed: {} };
  for (const variant of variants) {
    const requirements = variant.policy.requirements.filter(r => clauseMatches(r.conditions, event));
    if (variant.id === "clean") entry.requirements = requirements.map(r => r.id);
    if (requirements.length === 0) continue;
    const required = Math.max(...requirements.map(r => ACTION_SEVERITY[r.minimum_action]));
    for (const semantics of ["first_match", "most_restrictive"]) {
      const decision = evaluatePolicy(variant.policy, event, semantics);
      entry.exposed[`${variant.id}|${semantics}`] = ACTION_SEVERITY[decision.action] < required;
    }
  }
  records.push(entry);
}
await writeFile(output, JSON.stringify(records), "utf8");
console.log(`events=${records.length}`);
