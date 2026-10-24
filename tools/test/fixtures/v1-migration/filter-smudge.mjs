import fs from "node:fs"

const input = fs.readFileSync(0, "utf8")
const blockPath = process.env.LOCAL_BLOCK_FILE ?? ""
const block = blockPath ? fs.readFileSync(blockPath, "utf8").trim() : ""
if (!block) throw new Error("LOCAL_BLOCK_FILE is required")
if (input.includes("<!-- local:start -->")) {
  process.stdout.write(input)
  process.exit(0)
}
process.stdout.write(input.trimEnd() + "\n\n" + block + "\n")
