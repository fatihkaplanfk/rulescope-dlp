// Dense-overlap policy generator for the scalability experiment.
//
// Each rule is built around one "anchor" event that it is guaranteed to match
// effectively (conditions include the anchor; the exception, if any,
// contradicts the anchor). Rules that share an anchor therefore overlap on that
// event, and no rule has an empty match set. Further overlap comes from
// wildcards, multi-valued categorical conditions and wide size intervals.
//
// Anchors are assigned in balanced fashion (counts differ by at most one).
// Everything is deterministic in (n, density, seed). Parameters come from
// params.json and are not tuned after looking at performance results.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../../src/baseline.js";
import { DEFAULT_DOMAINS, loadAndValidatePolicy } from "../../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PARAMS = JSON.parse(readFileSync(resolve(here, "params.json"), "utf8"));
const SIZE_LIMITS = [0, 10240];

function seedFor(n, density, seed) {
  const densityIndex = { sparse: 1, medium: 2, dense: 3 }[density];
  return (seed * 1_000_003 + n * 101 + densityIndex * 7919) >>> 0;
}

export function anchorCount(n, density) {
  const expression = PARAMS.densities[density].anchors;
  if (expression === "n") return n;
  if (expression === "ceil(n/20)") return Math.ceil(n / 20);
  return Number(expression);
}

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function randomEventFrom(random) {
  const event = {};
  for (const [attribute, values] of Object.entries(DEFAULT_DOMAINS)) {
    event[attribute] = values[Math.floor(random() * values.length)];
  }
  event.size_mb = Math.floor(random() * (SIZE_LIMITS[1] + 1));
  return event;
}

// A clause that contains the anchor event.
function anchoredClause(anchor, settings, random) {
  const clause = {};
  for (const [attribute, values] of Object.entries(DEFAULT_DOMAINS)) {
    const roll = random();
    if (roll < settings.wildcard_p) {
      clause[attribute] = "*";
    } else if (roll < settings.wildcard_p + settings.multi_value_p) {
      const size = 2 + Math.floor(random() * (Math.max(2, Math.ceil(values.length / 2)) - 1));
      const others = shuffle(values.filter(v => v !== anchor[attribute]), random).slice(0, size - 1);
      clause[attribute] = [anchor[attribute], ...others];
    } else {
      clause[attribute] = anchor[attribute];
    }
  }
  const low = Math.max(SIZE_LIMITS[0], anchor.size_mb - Math.floor(random() * (settings.size_half_width + 1)));
  const high = Math.min(SIZE_LIMITS[1], anchor.size_mb + Math.floor(random() * (settings.size_half_width + 1)));
  clause.size_mb = { min: low, max: high };
  return clause;
}

// An exception that excludes part of the rule but never the anchor.
function exceptionAvoidingAnchor(conditions, anchor, random) {
  const candidates = [];
  for (const [attribute, values] of Object.entries(DEFAULT_DOMAINS)) {
    const constraint = conditions[attribute];
    const allowed = constraint === "*" ? values : Array.isArray(constraint) ? constraint : [constraint];
    const alternatives = allowed.filter(v => v !== anchor[attribute]);
    if (alternatives.length > 0) candidates.push({ attribute, alternatives });
  }
  if (candidates.length > 0) {
    const { attribute, alternatives } = candidates[Math.floor(random() * candidates.length)];
    return { [attribute]: alternatives[Math.floor(random() * alternatives.length)] };
  }
  const { min, max } = conditions.size_mb;
  if (anchor.size_mb < max) return { size_mb: { min: anchor.size_mb + 1, max } };
  if (anchor.size_mb > min) return { size_mb: { min, max: anchor.size_mb - 1 } };
  return null; // rule matches only the anchor point; no exception possible
}

export function generateDenseOverlapPolicy(n, density, seed) {
  const settings = PARAMS.densities[density];
  if (!settings) throw new Error(`Unknown density ${density}`);
  const random = mulberry32(seedFor(n, density, seed));
  const k = anchorCount(n, density);
  const anchors = Array.from({ length: k }, () => randomEventFrom(random));

  // Balanced anchor assignment: i mod k, then shuffled across rule positions.
  const assignment = shuffle(Array.from({ length: n }, (_, i) => i % k), random);
  const rules = assignment.map((anchorIndex, i) => ({
    id: `R${String(i + 1).padStart(4, "0")}`,
    priority: i + 1,
    conditions: anchoredClause(anchors[anchorIndex], settings, random),
    action: PARAMS.actions[Math.floor(random() * PARAMS.actions.length)]
  }));

  // Exactly round(fraction * n) rules receive one anchor-avoiding exception.
  const target = Math.round(PARAMS.exception_fraction * n);
  let given = 0;
  for (const index of shuffle(Array.from({ length: n }, (_, i) => i), random)) {
    if (given === target) break;
    const exception = exceptionAvoidingAnchor(rules[index].conditions, anchors[assignment[index]], random);
    if (exception) {
      rules[index].exceptions = [exception];
      given += 1;
    }
  }

  const requirements = Array.from({ length: PARAMS.requirement_count }, (_, j) => ({
    id: `REQ${j + 1}`,
    conditions: anchoredClause(anchors[j % k], settings, random),
    minimum_action: PARAMS.requirement_minimum_action
  }));

  const policy = loadAndValidatePolicy({
    name: `RuleScope-DLP dense-overlap n=${n} density=${density} seed=${seed}`,
    semantics: PARAMS.semantics,
    default_action: PARAMS.default_action,
    numeric_limits: { size_mb: SIZE_LIMITS },
    rules,
    requirements
  });
  return {
    policy,
    anchors,
    anchorOf: Object.fromEntries(rules.map((rule, i) => [rule.id, assignment[i]])),
    requirementAnchorOf: Object.fromEntries(requirements.map((req, j) => [req.id, j % k])),
    exceptions_assigned: given,
    exceptions_target: target
  };
}
