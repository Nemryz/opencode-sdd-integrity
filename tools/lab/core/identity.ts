import { makeLabId } from "./fs"

// Session and run ids already exist as plain lab ids, so identity adds the four ids the chain was missing.
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export function makeTaskId(): string {
  return `task-${makeLabId()}`
}

export function makePatchId(): string {
  return `patch-${makeLabId()}`
}

export function makeEvidenceId(): string {
  return `evidence-${makeLabId()}`
}

export function makePromotionId(): string {
  return `promotion-${makeLabId()}`
}

// Confirms a value is a plain safe id, so a traversal or a control character never reaches the provenance file.
export function isLabEntityId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value)
}
