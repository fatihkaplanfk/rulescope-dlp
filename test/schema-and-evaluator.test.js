import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/evaluator.js";
import { loadAndValidatePolicy } from "../src/schema.js";

test("policy validation rejects unknown domain values", () => {
  assert.throws(
    () => loadAndValidatePolicy({ rules: [{ id: "R1", conditions: { channel: "CarrierPigeon" }, action: "Block" }] }),
    /unknown value/i
  );
});

test("first-match and most-restrictive semantics can yield different decisions", () => {
  const policy = loadAndValidatePolicy({
    semantics: "first_match",
    rules: [
      { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
      { id: "R2", priority: 2, conditions: { channel: "Web" }, action: "Block" }
    ]
  });
  const event = {
    user_group: "Finance",
    data_classification: "Restricted",
    content_type: "Document",
    channel: "Web",
    destination_trust: "Untrusted",
    device_trust: "Managed",
    file_type: "PDF",
    size_mb: 2
  };
  assert.equal(evaluatePolicy(policy, event, "first_match").action, "Audit");
  assert.equal(evaluatePolicy(policy, event, "most_restrictive").action, "Block");
});

test("most-restrictive uses the default action only when no rule matches", () => {
  const policy = loadAndValidatePolicy({
    semantics: "most_restrictive",
    default_action: "Block",
    rules: [
      { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" }
    ]
  });
  const matchingEvent = {
    user_group: "Finance",
    data_classification: "Restricted",
    content_type: "Document",
    channel: "Web",
    destination_trust: "Untrusted",
    device_trust: "Managed",
    file_type: "PDF",
    size_mb: 2
  };
  const unmatchedEvent = { ...matchingEvent, channel: "Email" };

  assert.equal(evaluatePolicy(policy, matchingEvent, "most_restrictive").action, "Audit");
  assert.equal(evaluatePolicy(policy, unmatchedEvent, "most_restrictive").action, "Block");
});
