import fs from "node:fs"

const START = "<!-- local:start -->"
const END = "<!-- local:end -->"
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const input = fs.readFileSync(0, "utf8")
const block = new RegExp(`\\n?${escape(START)}[\\s\\S]*?${escape(END)}\\n?`, "g")
const cleaned = input.replace(block, "").trimEnd()
process.stdout.write(cleaned + "\n")
