function line(label, value) {
  return `${label.padEnd(22)}: ${value}`;
}

export function formatTextReport(report) {
  const output = [
    "PolicyLint-DLP Analysis Report",
    "=".repeat(30),
    line("Policy", report.policy),
    line("Semantics", report.semantics),
    line("Rules", report.rule_count),
    line("Requirements", report.requirement_count),
    line("Findings", report.finding_count),
    line("Elapsed", `${report.elapsed_ms.toFixed(2)} ms`),
    ""
  ];

  if (report.findings.length === 0) {
    output.push("No anomalies were found for the selected analyses.");
    return output.join("\n");
  }

  for (const [index, finding] of report.findings.entries()) {
    output.push(`[${index + 1}] ${finding.type.toUpperCase()}  ${finding.id}`);
    output.push(`    ${finding.explanation}`);
    if (finding.witness) {
      output.push("    Witness:");
      for (const [attribute, value] of Object.entries(finding.witness)) {
        output.push(`      ${attribute.padEnd(22)} ${value}`);
      }
    }
    output.push("");
  }
  return output.join("\n");
}
