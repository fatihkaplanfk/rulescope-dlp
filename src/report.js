function line(label, value) {
  return `${label.padEnd(22)}: ${value}`;
}

export function formatTextReport(report) {
  const output = [
    "RuleScope-DLP Analysis Report",
    "=".repeat(30),
    line("Policy", report.policy),
    line("Semantics", report.semantics),
    line("Rules", report.rule_count),
    line("Requirements", report.requirement_count),
    line("Findings", report.finding_count),
    line("Analysis status", report.analysis_status ?? "unknown"),
    line("Solver queries", formatQueryStats(report.query_stats)),
    line("Elapsed", `${report.elapsed_ms.toFixed(2)} ms`),
    ""
  ];

  if (report.complete === false) {
    const unknown = report.query_stats.unknown;
    output.push(
      `ANALYSIS INCOMPLETE: ${unknown} solver ${unknown === 1 ? "query was" : "queries were"} inconclusive (UNKNOWN). ` +
      "Missing findings are not established as absent."
    );
    for (const query of report.inconclusive_queries ?? []) {
      output.push(`  - ${query.check}${query.subject ? ` [${query.subject}]` : ""}: ${query.status}` +
        (query.reason_unknown ? ` (${query.reason_unknown})` : ""));
    }
    output.push("");
  }

  if (report.findings.length === 0) {
    output.push(report.complete === false
      ? "No anomalies were reported, but the analysis is incomplete."
      : "No anomalies were found for the selected analyses.");
    return output.join("\n");
  }

  for (const [index, finding] of report.findings.entries()) {
    output.push(`[${index + 1}] ${finding.type.toUpperCase()}  ${finding.id}`);
    output.push(`    ${finding.explanation}`);
    if (finding.witness) {
      output.push(finding.evidence_kind === "representative_event"
        ? "    Representative event (illustration only; the property is established by UNSAT):"
        : `    ${finding.evidence_kind === "counterexample" ? "Counterexample" : "Witness"}:`);
      for (const [attribute, value] of Object.entries(finding.witness)) {
        output.push(`      ${attribute.padEnd(22)} ${value}`);
      }
    }
    output.push("");
  }
  return output.join("\n");
}

function formatQueryStats(stats) {
  if (!stats) return "n/a";
  return `${stats.total} (SAT ${stats.sat}, UNSAT ${stats.unsat}, UNKNOWN ${stats.unknown})`;
}
