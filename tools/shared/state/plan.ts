// This module owns the immutable state plan and the simulation that predicts the exact post apply hash.

import crypto from "node:crypto"
import {
  ConfigSchema,
  PATHS,
  StatePlanSchema,
  StateOperationSchema,
  StatePreconditionSchema,
  type StateOperation,
  type StatePlan,
  type StatePrecondition,
} from "../schemas"
import { prepareSessionForWrite } from "./session"
import { prepareSpecJsonForWrite } from "./spec"
import {
  assertNoSymlinkParents,
  assertSafeRelativePath,
  canonicalJson,
  readPathTree,
  sha256,
} from "./paths"

export type StateErrorCode =
  | "PLAN_INVALID"
  | "STALE_BASE"
  | "PRECONDITION"
  | "TARGET_EXISTS"
  | "APPLY_FAILED"
  | "ROLLBACK_FAILED"

export class StateTransactionError extends Error {
  readonly code: StateErrorCode

  constructor(code: StateErrorCode, message: string) {
    super(message)
    this.name = "StateTransactionError"
    this.code = code
  }
}

export interface CreateStatePlanInput {
  root: string
  scope: string[]
  preconditions: StatePrecondition[]
  operations: StateOperation[]
  now?: Date
  planId?: string
}

export interface VirtualState {
  files: Map<string, string>
  dirs: Set<string>
}

const SESSION_STATE_PATH = `${PATHS.OPENCODE_DIR}/${PATHS.SPEC_MEMORY_DIR}/${PATHS.SESSION_FILE}`
const CONFIG_STATE_PATH = `${PATHS.OPENCODE_DIR}/${PATHS.SPEC_MEMORY_DIR}/${PATHS.CONFIG_FILE}`

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

export function normalizeScope(scope: string[]): string[] {
  const unique = [...new Set(scope)].sort()
  for (const entry of unique) assertSafeRelativePath(entry)
  return unique.filter((entry) => !unique.some((parent) => parent !== entry && entry.startsWith(`${parent}/`)))
}

function operationPaths(operation: StateOperation): string[] {
  switch (operation.kind) {
    case "rename-dir":
      return [operation.from, operation.to]
    case "write-spec-json":
      return [operation.featureDir]
    case "write-session":
      return [SESSION_STATE_PATH]
    case "write-config":
      return [CONFIG_STATE_PATH]
  }
}

export function stateWritePath(operation: StateOperation): string | null {
  switch (operation.kind) {
    case "write-spec-json":
      return `${operation.featureDir}/spec.json`
    case "write-session":
      return SESSION_STATE_PATH
    case "write-config":
      return CONFIG_STATE_PATH
    default:
      return null
  }
}

async function prepareOperation(operation: StateOperation, now: Date): Promise<StateOperation> {
  switch (operation.kind) {
    case "rename-dir":
      return { ...operation }
    case "write-spec-json":
      return { ...operation, data: prepareSpecJsonForWrite(operation.data, now) }
    case "write-session":
      return { ...operation, data: prepareSessionForWrite(operation.data) }
    case "write-config": {
      const result = ConfigSchema.safeParse(operation.data)
      if (!result.success) {
        throw new StateTransactionError("PLAN_INVALID", `invalid config operation: ${String(result.error)}`)
      }
      return { ...operation, data: result.data }
    }
  }
}

async function validateOperationPaths(root: string, operations: StateOperation[]): Promise<void> {
  for (const operation of operations) {
    for (const rel of operationPaths(operation)) {
      assertSafeRelativePath(rel)
      await assertNoSymlinkParents(root, rel)
    }

    if (operation.kind === "rename-dir") {
      if (operation.from === operation.to) {
        throw new StateTransactionError("PLAN_INVALID", "rename source and target are identical")
      }
      if (operation.from.startsWith(`${operation.to}/`) || operation.to.startsWith(`${operation.from}/`)) {
        throw new StateTransactionError("PLAN_INVALID", "rename source and target overlap")
      }
      const source = await readPathTree(root, operation.from)
      if (source.kind !== "dir") {
        throw new StateTransactionError("PRECONDITION", `rename source is not a directory: ${operation.from}`)
      }
      const target = await readPathTree(root, operation.to)
      if (target.kind !== "absent") {
        throw new StateTransactionError("TARGET_EXISTS", `rename target already exists: ${operation.to}`)
      }
    }

    const writePath = stateWritePath(operation)
    if (writePath) {
      const current = await readPathTree(root, writePath)
      if (current.kind === "dir") {
        throw new StateTransactionError("TARGET_EXISTS", `state file is a directory: ${writePath}`)
      }
    }
  }
}

export async function checkStatePreconditions(root: string, preconditions: StatePrecondition[]): Promise<void> {
  for (const precondition of preconditions) {
    assertSafeRelativePath(precondition.path)
    const tree = await readPathTree(root, precondition.path)
    if (precondition.kind === "absent") {
      if (tree.kind !== "absent") {
        throw new StateTransactionError("TARGET_EXISTS", `state path already exists: ${precondition.path}`)
      }
      continue
    }
    if (tree.kind !== precondition.kind) {
      throw new StateTransactionError(
        "PRECONDITION",
        `state path is ${tree.kind}, expected ${precondition.kind}: ${precondition.path}`,
      )
    }
    if (precondition.sha256) {
      const actual = sha256(canonicalJson(tree))
      if (actual !== precondition.sha256) {
        throw new StateTransactionError("PRECONDITION", `state hash changed: ${precondition.path}`)
      }
    }
  }
}

function addParents(state: VirtualState, rel: string): void {
  const segments = rel.split("/")
  let current = ""
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment
    state.dirs.add(current)
  }
}

export async function readVirtualState(root: string, scope: string[]): Promise<VirtualState> {
  const state: VirtualState = { files: new Map(), dirs: new Set() }
  for (const rel of scope) {
    const tree = await readPathTree(root, rel)
    if (tree.kind === "file") {
      state.files.set(rel, tree.sha256)
      addParents(state, rel)
      continue
    }
    if (tree.kind === "dir") {
      state.dirs.add(rel)
      for (const entry of tree.entries) {
        state.files.set(entry.path, entry.sha256)
        addParents(state, entry.path)
      }
    }
  }
  return state
}

function cloneVirtualState(state: VirtualState): VirtualState {
  return { files: new Map(state.files), dirs: new Set(state.dirs) }
}

function treeFromVirtualState(state: VirtualState, rel: string) {
  const fileHash = state.files.get(rel)
  if (fileHash) return { kind: "file" as const, sha256: fileHash }
  const prefix = `${rel}/`
  const entries = [...state.files.entries()]
    .filter(([entryPath]) => entryPath.startsWith(prefix))
    .map(([entryPath, hash]) => ({ path: entryPath, sha256: hash }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (entries.length > 0 || state.dirs.has(rel)) {
    return { kind: "dir" as const, entries }
  }
  return { kind: "absent" as const }
}

function hashVirtualTree(state: VirtualState, rel: string): string {
  const tree = treeFromVirtualState(state, rel)
  return tree.kind === "absent" ? "absent" : sha256(canonicalJson(tree))
}

export function hashVirtualScope(state: VirtualState, scope: string[]): string {
  const entries = [...new Set(scope)]
    .sort()
    .map((rel) => ({ path: rel, hash: hashVirtualTree(state, rel) }))
  return sha256(canonicalJson(entries))
}

function setVirtualFile(state: VirtualState, rel: string, hash: string): void {
  if (state.dirs.has(rel)) {
    throw new StateTransactionError("TARGET_EXISTS", `state file collides with a directory: ${rel}`)
  }
  const prefix = `${rel}/`
  if ([...state.files.keys()].some((entry) => entry.startsWith(prefix))) {
    throw new StateTransactionError("TARGET_EXISTS", `state file collides with a directory: ${rel}`)
  }
  state.files.set(rel, hash)
  addParents(state, rel)
}

function moveVirtualDir(state: VirtualState, from: string, to: string): void {
  const targetPrefix = `${to}/`
  if (
    state.files.has(to)
    || state.dirs.has(to)
    || [...state.files.keys()].some((entry) => entry.startsWith(targetPrefix))
  ) {
    throw new StateTransactionError("TARGET_EXISTS", `rename target already exists: ${to}`)
  }

  const fileMoves = [...state.files.entries()].filter(([entry]) => entry === from || entry.startsWith(`${from}/`))
  for (const [entry, hash] of fileMoves) {
    state.files.delete(entry)
    state.files.set(`${to}${entry.slice(from.length)}`, hash)
  }

  const dirMoves = [...state.dirs].filter((entry) => entry === from || entry.startsWith(`${from}/`))
  for (const entry of dirMoves) {
    state.dirs.delete(entry)
    state.dirs.add(`${to}${entry.slice(from.length)}`)
  }
  state.dirs.add(to)
  addParents(state, to)
}

function applyOperationToVirtual(state: VirtualState, operation: StateOperation): void {
  switch (operation.kind) {
    case "rename-dir":
      moveVirtualDir(state, operation.from, operation.to)
      return
    case "write-spec-json":
      setVirtualFile(
        state,
        `${operation.featureDir}/spec.json`,
        sha256(JSON.stringify(operation.data, null, 2)),
      )
      return
    case "write-session":
      setVirtualFile(state, SESSION_STATE_PATH, sha256(JSON.stringify(operation.data, null, 2)))
      return
    case "write-config":
      setVirtualFile(state, CONFIG_STATE_PATH, sha256(JSON.stringify(operation.data, null, 2)))
      return
  }
}

export async function simulateExpectedState(
  root: string,
  scope: string[],
  operations: StateOperation[],
): Promise<{ baseHash: string; expectedHash: string; virtual: VirtualState }> {
  const virtual = await readVirtualState(root, scope)
  const baseHash = hashVirtualScope(virtual, scope)
  const expectedVirtual = cloneVirtualState(virtual)
  for (const operation of operations) applyOperationToVirtual(expectedVirtual, operation)
  return { baseHash, expectedHash: hashVirtualScope(expectedVirtual, scope), virtual }
}

export function computePlanHash(plan: StatePlan | Omit<StatePlan, "planHash">): string {
  return sha256(canonicalJson({
    format: plan.format,
    planId: plan.planId,
    createdAt: plan.createdAt,
    scope: plan.scope,
    preconditions: plan.preconditions,
    operations: plan.operations,
    baseHash: plan.baseHash,
    expectedHash: plan.expectedHash,
  }))
}

export function validateStatePlan(plan: StatePlan): StatePlan {
  const parsed = StatePlanSchema.safeParse(plan)
  if (!parsed.success) {
    throw new StateTransactionError("PLAN_INVALID", `invalid state plan: ${String(parsed.error)}`)
  }
  if (computePlanHash(parsed.data) !== parsed.data.planHash) {
    throw new StateTransactionError("PLAN_INVALID", "state plan hash does not match its content")
  }
  return parsed.data
}

export async function createStatePlan(input: CreateStatePlanInput): Promise<StatePlan> {
  const root = input.root
  const now = input.now ?? new Date()
  const operations: StateOperation[] = []
  for (const raw of input.operations) {
    const parsed = StateOperationSchema.safeParse(raw)
    if (!parsed.success) {
      throw new StateTransactionError("PLAN_INVALID", `invalid state operation: ${String(parsed.error)}`)
    }
    operations.push(await prepareOperation(parsed.data, now))
  }

  const preconditions = StatePreconditionSchema.array().parse(input.preconditions)
  const scope = normalizeScope([...input.scope, ...operations.flatMap(operationPaths)])
  if (scope.length === 0) {
    throw new StateTransactionError("PLAN_INVALID", "state plan scope is empty")
  }

  await validateOperationPaths(root, operations)
  for (const rel of scope) await assertNoSymlinkParents(root, rel)
  await checkStatePreconditions(root, preconditions)

  const { baseHash, expectedHash } = await simulateExpectedState(root, scope, operations)

  const body = {
    format: 1 as const,
    planId: input.planId ?? crypto.randomUUID(),
    createdAt: now.toISOString(),
    scope,
    preconditions,
    operations,
    baseHash,
    expectedHash,
  }
  const plan = StatePlanSchema.parse({ ...body, planHash: computePlanHash(body) })
  return deepFreeze(plan)
}
