// Reads Stryker JSON reports and publishes their scores, using the package Stryker itself uses so a number cannot drift from theirs.
// Accepts pairs of report path and label, so one report prints one row and several reports also print a combined row.
import fs from "node:fs/promises"
import path from "node:path"
import { calculateMutationTestMetrics } from "mutation-testing-metrics"

function readPairs(input) {
  const pairs = []
  for (let index = 0; index < input.length; index += 2) {
    const reportPath = input[index]
    if (!reportPath) break
    pairs.push({ reportPath, label: input[index + 1] ?? path.basename(path.dirname(reportPath)) })
  }
  if (pairs.length === 0) {
    pairs.push({ reportPath: path.join("reports", "mutation", "mutation.json"), label: "batch" })
  }
  return pairs
}

// Merging the file maps under the label as prefix keeps two batches from colliding on a shared name and keeps the combined score exact.
function mergeReports(reports) {
  const files = {}
  for (const entry of reports) {
    for (const [name, value] of Object.entries(entry.report.files ?? {})) {
      files[`${entry.label}/${name}`] = value
    }
  }
  return { files }
}

function scoreOf(report) {
  const metrics = calculateMutationTestMetrics(report).systemUnderTestMetrics.metrics
  const format = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a")
  return {
    score: format(metrics.mutationScore),
    covered: format(metrics.mutationScoreBasedOnCoveredCode),
    files: Object.keys(report.files ?? {}).length,
    totalMutants: metrics.totalMutants,
    valid: metrics.totalValid,
    invalid: metrics.totalInvalid,
    killed: metrics.killed,
    survived: metrics.survived,
    noCoverage: metrics.noCoverage,
  }
}

function row(label, m) {
  return `| ${label} | ${m.files} | ${m.totalMutants} | ${m.valid} | ${m.invalid} | ${m.killed} | ${m.survived} | ${m.noCoverage} | **${m.score}%** |`
}

const pairs = readPairs(process.argv.slice(2))
const loaded = []
const rows = []

for (const pair of pairs) {
  const report = JSON.parse(await fs.readFile(pair.reportPath, "utf-8"))
  loaded.push({ label: pair.label, report })
  rows.push(row(pair.label, scoreOf(report)))
}

const combined = loaded.length > 1 ? scoreOf(mergeReports(loaded)) : null
if (combined) rows.push(row("**all**", combined))

const title = combined ? "Mutation score for all batches" : `Mutation score for ${loaded[0].label}`
const table = [
  `### ${title}`,
  "",
  "| Batch | Files | Mutants | Valid | Invalid | Killed | Survived | No coverage | Score |",
  "|-------|-------|---------|-------|---------|--------|----------|------------|-------|",
  ...rows,
  "",
  "Static mutants are ignored by the current configuration, so the score does not count them.",
  "",
].join("\n")

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) await fs.appendFile(summaryPath, table, "utf-8")
else console.log(table)

const headline = combined ?? scoreOf(loaded[0].report)
console.log(`score=${headline.score}`)
console.log(`killed=${headline.killed}`)
console.log(`survived=${headline.survived}`)
console.log(`noCoverage=${headline.noCoverage}`)
console.log(`invalid=${headline.invalid}`)
console.log(`valid=${headline.valid}`)
