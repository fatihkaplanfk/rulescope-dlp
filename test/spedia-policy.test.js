import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/evaluator.js";
import { buildSpediaPolicies } from "../experiments/spedia-policy.js";

const externalAttachment = {
  user_group: "General",
  data_classification: "Restricted",
  content_type: "Attachment",
  channel: "Email",
  destination_trust: "Untrusted",
  device_trust: "Managed",
  file_type: "OTHER",
  size_mb: 1
};

const usbConnect = {
  user_group: "General",
  data_classification: "Internal",
  content_type: "DeviceConnect",
  channel: "USB",
  destination_trust: "Untrusted",
  device_trust: "Unmanaged",
  file_type: "OTHER",
  size_mb: 0
};

test("SPEDIA mutations produce the intended semantic decisions", () => {
  const variants = Object.fromEntries(buildSpediaPolicies().map(item => [item.id, item.policy]));
  assert.equal(evaluatePolicy(variants.clean, externalAttachment, "first_match").action, "Block");
  assert.equal(evaluatePolicy(variants.shadow_email, externalAttachment, "first_match").action, "Permit");
  assert.equal(evaluatePolicy(variants.shadow_email, externalAttachment, "most_restrictive").action, "Block");
  assert.equal(evaluatePolicy(variants.exception_usb, usbConnect, "first_match").action, "Permit");
  assert.equal(evaluatePolicy(variants.exception_usb, usbConnect, "most_restrictive").action, "Permit");
});

