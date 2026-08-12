export const DEFAULT_DOMAINS = Object.freeze({
  user_group: ["Finance", "HR", "Engineering", "Executive", "Security"],
  data_classification: ["Public", "Internal", "Confidential", "Restricted"],
  content_type: ["Document", "Spreadsheet", "SourceCode", "Archive", "PlainText"],
  channel: ["Email", "Web", "CloudUpload", "USB", "Print", "Clipboard", "LAN", "EndpointApp"],
  destination_trust: ["Trusted", "Partner", "Untrusted"],
  device_trust: ["Managed", "Unmanaged"],
  file_type: ["PDF", "DOCX", "XLSX", "CSV", "ZIP", "TXT"]
});

export const ACTION_SEVERITY = Object.freeze({
  Permit: 0,
  Audit: 1,
  Warn: 2,
  Encrypt: 3,
  Quarantine: 4,
  Block: 5
});

export const ANALYSIS_TYPES = Object.freeze([
  "shadowing",
  "redundancy",
  "action_conflict",
  "coverage_gap",
  "exception_leakage",
  "semantic_divergence"
]);

export function normalizePolicy(raw) {
  return {
    name: raw.name ?? "Unnamed DLP policy",
    version: raw.version ?? "1.0",
    semantics: raw.semantics ?? "first_match",
    default_action: raw.default_action ?? "Permit",
    domains: { ...DEFAULT_DOMAINS, ...(raw.domains ?? {}) },
    numeric_limits: {
      size_mb: raw.numeric_limits?.size_mb ?? [0, 10240]
    },
    rules: (raw.rules ?? []).map((rule, index) => ({
      id: rule.id ?? `R${String(index + 1).padStart(4, "0")}`,
      description: rule.description ?? "",
      enabled: rule.enabled !== false,
      priority: Number.isInteger(rule.priority) ? rule.priority : index + 1,
      conditions: rule.conditions ?? {},
      exceptions: Array.isArray(rule.exceptions)
        ? rule.exceptions
        : rule.exceptions
          ? [rule.exceptions]
          : [],
      action: rule.action ?? "Audit"
    })),
    requirements: (raw.requirements ?? []).map((requirement, index) => ({
      id: requirement.id ?? `REQ${String(index + 1).padStart(3, "0")}`,
      description: requirement.description ?? "",
      conditions: requirement.conditions ?? {},
      minimum_action: requirement.minimum_action ?? "Block"
    }))
  };
}

export function validatePolicy(policy) {
  const errors = [];
  const allowedSemantics = new Set(["first_match", "most_restrictive"]);
  if (!allowedSemantics.has(policy.semantics)) {
    errors.push(`Unsupported semantics: ${policy.semantics}`);
  }
  if (!(policy.default_action in ACTION_SEVERITY)) {
    errors.push(`Unknown default action: ${policy.default_action}`);
  }

  for (const [attribute, values] of Object.entries(policy.domains)) {
    if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) {
      errors.push(`Domain ${attribute} must contain unique values.`);
    }
  }

  const ids = new Set();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) errors.push(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!(rule.action in ACTION_SEVERITY)) errors.push(`Unknown action in ${rule.id}: ${rule.action}`);
    validateClause(rule.conditions, policy, `${rule.id}.conditions`, errors);
    rule.exceptions.forEach((clause, index) =>
      validateClause(clause, policy, `${rule.id}.exceptions[${index}]`, errors)
    );
  }

  for (const requirement of policy.requirements) {
    if (!(requirement.minimum_action in ACTION_SEVERITY)) {
      errors.push(`Unknown minimum action in ${requirement.id}: ${requirement.minimum_action}`);
    }
    validateClause(requirement.conditions, policy, `${requirement.id}.conditions`, errors);
  }

  if (errors.length) {
    const error = new Error(`Invalid policy:\n- ${errors.join("\n- ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return policy;
}

function validateClause(clause, policy, path, errors) {
  for (const [attribute, constraint] of Object.entries(clause)) {
    if (attribute === "size_mb") {
      if (typeof constraint === "number") continue;
      if (
        typeof constraint !== "object" ||
        constraint === null ||
        (constraint.min !== undefined && typeof constraint.min !== "number") ||
        (constraint.max !== undefined && typeof constraint.max !== "number")
      ) {
        errors.push(`${path}.size_mb must be a number or {min,max}.`);
      }
      continue;
    }
    const domain = policy.domains[attribute];
    if (!domain) {
      errors.push(`${path} uses unknown attribute: ${attribute}`);
      continue;
    }
    const requested = constraint === "*" ? [] : Array.isArray(constraint) ? constraint : [constraint];
    for (const value of requested) {
      if (!domain.includes(value)) errors.push(`${path}.${attribute} uses unknown value: ${value}`);
    }
  }
}

export function loadAndValidatePolicy(raw) {
  return validatePolicy(normalizePolicy(raw));
}
