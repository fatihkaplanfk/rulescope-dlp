// Differential check: symbolic decision expressions vs. the concrete evaluator
// on every event of small, fully enumerable event spaces.
//
// Scope: this compares two implementations that share the policy schema,
// the normalisation step (src/schema.js), the action-severity order and the
// rule-ordering function (src/ordering.js). Agreement shows that the SMT
// encoding and the concrete evaluator implement the same semantics; it does
// not independently validate those shared definitions or design assumptions.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../src/analyzer.js";
import { mulberry32 } from "../src/baseline.js";
import { evaluatePolicy } from "../src/evaluator.js";
import { ACTION_SEVERITY, loadAndValidatePolicy } from "../src/schema.js";

let api;
before(async () => {
  api = await z3Solver.init();
});
after(() => {
  api?.em.PThread?.terminateAllThreads?.();
});

// Every attribute is overridden so that the event space is small.
const DOMAINS = {
  user_group: ["U1", "U2"],
  data_classification: ["Internal"],
  content_type: ["Doc"],
  channel: ["Web", "USB"],
  destination_trust: ["Trusted", "Untrusted"],
  device_trust: ["Managed"],
  file_type: ["PDF", "ZIP"]
};
const SIZE = [0, 3];
const ACTIONS = Object.keys(ACTION_SEVERITY);

function allEvents() {
  let events = [{}];
  for (const [attribute, values] of Object.entries(DOMAINS)) {
    events = events.flatMap(event => values.map(value => ({ ...event, [attribute]: value })));
  }
  const sizes = Array.from({ length: SIZE[1] - SIZE[0] + 1 }, (_, i) => SIZE[0] + i);
  return events.flatMap(event => sizes.map(size_mb => ({ ...event, size_mb })));
}

async function compareAll(raw, label) {
  const policy = loadAndValidatePolicy({ domains: DOMAINS, numeric_limits: { size_mb: SIZE }, ...raw });
  const analyzer = new DlpAnalyzer(api.Context, policy, `diff_${label}`);
  const z = analyzer.z;
  const expressions = {
    first_match: analyzer.decisionExpression(policy.rules, "first_match"),
    most_restrictive: analyzer.decisionExpression(policy.rules, "most_restrictive")
  };
  let compared = 0;
  for (const event of allEvents()) {
    const pins = Object.entries(DOMAINS).map(([attribute, values]) =>
      analyzer.variables[attribute].eq(values.indexOf(event[attribute])));
    pins.push(analyzer.variables.size_mb.eq(event.size_mb));
    const solution = await analyzer.solve(pins, "differential");
    assert.equal(solution.status, "sat", `${label}: event outside the symbolic domain`);
    for (const [semantics, expression] of Object.entries(expressions)) {
      const symbolic = Number(solution.model.eval(expression, true).value());
      const concrete = ACTION_SEVERITY[evaluatePolicy(policy, event, semantics).action];
      assert.equal(symbolic, concrete, `${label} ${semantics} ${JSON.stringify(event)}`);
      compared += 1;
    }
    analyzer.closeSolution(solution);
  }
  void z;
  return compared;
}

test("hand-written policies: defaults, ties, disabled rules, multiple exceptions, overlap, size edges", async () => {
  const cases = {
    empty_policy_default_block: { default_action: "Block", rules: [] },
    tie_and_disabled: {
      default_action: "Warn",
      rules: [
        { id: "b", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
        { id: "A", priority: 1, conditions: { channel: "Web", file_type: "PDF" }, action: "Block" },
        { id: "OFF", priority: 0, enabled: false, conditions: {}, action: "Permit" }
      ]
    },
    multiple_exceptions: {
      default_action: "Permit",
      rules: [
        {
          id: "R1", priority: 1, conditions: { channel: ["Web", "USB"] }, action: "Block",
          exceptions: [{ user_group: "U1", destination_trust: "Trusted" }, { file_type: "ZIP", size_mb: 3 }]
        },
        { id: "R2", priority: 2, conditions: { user_group: "U1" }, action: "Encrypt" }
      ]
    },
    size_boundaries: {
      default_action: "Audit",
      rules: [
        { id: "LOW", priority: 1, conditions: { size_mb: { max: 0 } }, action: "Warn" },
        { id: "MID", priority: 2, conditions: { size_mb: { min: 1, max: 2 } }, action: "Quarantine" },
        { id: "TOP", priority: 3, conditions: { size_mb: 3 }, action: "Permit" },
        { id: "ALL", priority: 4, conditions: { channel: "USB" }, action: "Block" }
      ]
    },
    empty_exception_and_wildcards: {
      default_action: "Encrypt",
      rules: [
        { id: "DEAD", priority: 1, conditions: { channel: "*" }, exceptions: [{}], action: "Block" },
        { id: "LIVE", priority: 2, conditions: { destination_trust: "Untrusted" }, action: "Audit" }
      ]
    }
  };
  let compared = 0;
  for (const [label, raw] of Object.entries(cases)) compared += await compareAll(raw, label);
  assert.equal(compared, Object.keys(cases).length * allEvents().length * 2);
});

test("40 seeded random policies agree on every event under both semantics", async () => {
  const random = mulberry32(20261019);
  const pick = values => values[Math.floor(random() * values.length)];
  const constraint = values => {
    const roll = random();
    if (roll < 0.4) return undefined;
    if (roll < 0.55) return "*";
    if (roll < 0.8) return pick(values);
    return values.filter(() => random() < 0.5);
  };
  const clause = () => {
    const result = {};
    for (const [attribute, values] of Object.entries(DOMAINS)) {
      const value = constraint(values);
      if (value !== undefined) result[attribute] = value;
    }
    const sizeRoll = random();
    if (sizeRoll < 0.2) result.size_mb = Math.floor(random() * 4);
    else if (sizeRoll < 0.45) {
      const a = Math.floor(random() * 5) - 1;
      const b = Math.floor(random() * 5) - 1;
      result.size_mb = { min: Math.min(a, b), max: Math.max(a, b) };
    }
    return result;
  };
  let compared = 0;
  for (let index = 0; index < 40; index += 1) {
    const rules = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, r) => ({
      id: `R${r}${pick(["", "a", "B"])}`,
      priority: Math.floor(random() * 3),
      enabled: random() > 0.15,
      conditions: clause(),
      exceptions: Array.from({ length: Math.floor(random() * 3) }, clause),
      action: pick(ACTIONS)
    }));
    const unique = rules.filter((rule, i) => rules.findIndex(other => other.id === rule.id) === i);
    compared += await compareAll({ default_action: pick(ACTIONS), rules: unique }, `random_${index}`);
  }
  assert.ok(compared > 0);
});
