// Reads a Stryker JSON report and publishes its score, using the same package Stryker itself uses so the number cannot drift.
import fs from "node:fs/promises"
import path from "node:path"
import { calculateMutationTestMetrics } from "mutation-testing-metrics"

const reportPath = process.argv[2] ?? path.join("reports", "mutation", "mutation.json")
const label = process.argv[3] ?? "batch"

const raw = await fs.readFile(reportPath, "utf-8")
const report = JSON.parse(raw)
const metrics = calculateMutationTestMetrics(report).systemUnderTestMetrics.metrics

const score = Number.isFinite(metrics.mutationScore) ? metrics.mutationScore.toFixed(2) : "n/a"
const covered = Number.isFinite(metrics.mutationScoreBasedOnCoveredCode)
  ? metrics.mutationScoreBasedOnCoveredCode.toFixed(2)
  : "n/a"

const files = Object.keys(report.files).length
const row = [
  `| ${label} | ${files} | ${metrics.totalMutants} | ${metrics.totalValid} | ${metrics.totalInvalid} | ${metrics.killed} | ${metrics.survived} | ${metrics.noCoverage} | **${score}%** |`,
].join("")

const header = [
  `### Mutation score for ${label}`,
  "",
  "| Batch | Files | Mutants | Valid | Invalid | Killed | Survived | No coverage | Score |",
  "|-------|-------|---------|-------|---------|--------|----------|------------|-------|",
  row,
  "",
  "Static mutants are ignored by the current configuration, so the score does not count them.",
  "",
].join("\n")

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  await fs.appendFile(summaryPath, header, "utf-8")
} else {
  console.log(header)
}

// The score travels as an output so a later step or a summary job can reuse it without reading the report again.
console.log(`score=${score}`)
console.log(`killed=${metrics.killed}`)
console.log(`survived=${metrics.survived}`)
console.log(`noCoverage=${metrics.noCoverage}`)
console.log(`invalid=${metrics.totalInvalid}`)
