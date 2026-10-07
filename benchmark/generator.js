import { DEFAULT_DOMAINS, loadAndValidatePolicy } from "../src/schema.js";
import { findingId } from "../src/analyzer.js";
import { mulberry32 } from "../src/baseline.js";

const BASE_CLASSIFICATIONS = ["Public", "Internal", "Confidential"];
const BASE_ACTIONS = ["Audit", "Warn", "Encrypt", "Block"];

export function generateBenchmarkPolicy(ruleCount, seed) {
  if (ruleCount < 10) throw new Error("Benchmark policies require at least 10 rules.");
  const random = mulberry32(seed);
  const baseTuples = cartesian([
    DEFAULT_DOMAINS.user_group,
    BASE_CLASSIFICATIONS,
    DEFAULT_DOMAINS.content_type,
    DEFAULT_DOMAINS.channel,
    DEFAULT_DOMAINS.destination_trust,
    DEFAULT_DOMAINS.device_trust,
    DEFAULT_DOMAINS.file_type
  ]);
  shuffle(baseTuples, random);

  const plantedRuleCount = 5;
  const rules = [];
  for (let index = 0; index < ruleCount - plantedRuleCount; index += 1) {
    const tuple = baseTuples[index];
    const [user, classification, content, channel, destination, device, file] = tuple;
    rules.push({
      id: `B${String(index + 1).padStart(4, "0")}`,
      priority: index + 1,
      conditions: {
        user_group: user,
        data_classification: classification,
        content_type: content,
        channel,
        destination_trust: destination,
        device_trust: device,
        file_type: file,
        size_mb: { min: 0, max: 10240 }
      },
      action: BASE_ACTIONS[index % BASE_ACTIONS.length]
    });
  }

  let priority = rules.length + 1;
  const rareRange = { min: 0, max: 10240 };
  rules.push(
    {
      id: "CF1",
      priority: priority++,
      description: "Specific audit rule used to plant an action conflict.",
      conditions: controlledClause({ user_group: "Finance", channel: "Web", file_type: "PDF", size_mb: rareRange }),
      action: "Audit"
    },
    {
      id: "CF2",
      priority: priority++,
      description: "Broader blocking rule that overlaps CF1 without being fully shadowed.",
      conditions: controlledClause({ user_group: "Finance", channel: "Web", file_type: "*", size_mb: rareRange }),
      action: "Block"
    },
    {
      id: "SH1",
      priority: priority++,
      description: "First copy of a duplicated rule.",
      conditions: controlledClause({ user_group: "HR", channel: "Email", file_type: "DOCX", size_mb: rareRange }),
      action: "Audit"
    },
    {
      id: "SH2",
      priority: priority++,
      description: "Second copy, planted as shadowed and redundant.",
      conditions: controlledClause({ user_group: "HR", channel: "Email", file_type: "DOCX", size_mb: rareRange }),
      action: "Audit"
    },
    {
      id: "EX1",
      priority: priority++,
      description: "Protective cloud rule with an unsafe executive exception.",
      conditions: controlledClause({ user_group: "*", channel: "CloudUpload", file_type: "ZIP", size_mb: rareRange }),
      exceptions: [{ user_group: "Executive" }],
      action: "Block"
    }
  );

  const requirements = [
    {
      id: "GAP_REQ",
      description: "Restricted USB transfers to unmanaged and untrusted destinations must be blocked.",
      conditions: controlledClause({
        user_group: "Security",
        channel: "USB",
        file_type: "CSV",
        device_trust: "Unmanaged",
        size_mb: rareRange
      }),
      minimum_action: "Block"
    },
    {
      id: "EX_REQ",
      description: "Executive uploads of restricted archives to untrusted cloud storage must be blocked.",
      conditions: controlledClause({
        user_group: "Executive",
        channel: "CloudUpload",
        file_type: "ZIP",
        size_mb: rareRange
      }),
      minimum_action: "Block"
    }
  ];

  const expectedFindingIds = new Set([
    findingId("action_conflict", "CF1", "CF2"),
    findingId("shadowing", "SH2"),
    findingId("redundancy", "SH1"),
    findingId("redundancy", "SH2"),
    findingId("coverage_gap", "GAP_REQ"),
    findingId("coverage_gap", "EX_REQ"),
    findingId("exception_leakage", "EX1", "0", "EX_REQ")
  ]);

  return {
    policy: loadAndValidatePolicy({
      name: `RuleScope-DLP controlled benchmark n=${ruleCount} seed=${seed}`,
      version: "1.0",
      semantics: "first_match",
      default_action: "Permit",
      numeric_limits: { size_mb: [0, 10240] },
      rules,
      requirements
    }),
    expectedFindingIds
  };
}

function controlledClause(overrides) {
  return {
    user_group: "Finance",
    data_classification: "Restricted",
    content_type: "Archive",
    channel: "Web",
    destination_trust: "Untrusted",
    device_trust: "Managed",
    file_type: "PDF",
    size_mb: { min: 100, max: 200 },
    ...overrides
  };
}

function cartesian(arrays) {
  return arrays.reduce(
    (accumulator, values) => accumulator.flatMap(prefix => values.map(value => [...prefix, value])),
    [[]]
  );
}

function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}
