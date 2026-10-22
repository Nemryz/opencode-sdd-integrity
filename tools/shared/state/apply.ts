// This module owns the apply protocol: lock, stale check, journal, operations, final hash check and rollback.

import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { atomicWriteFile } from "../atomic"
import { withLock } from "../locks"
import type { StateJournal, StateJournalBackup, StateOperation, StatePlan } from "../schemas"
import { tryAutoCommit } from "./config"
import {
  checkStatePreconditions,
  simulateExpectedState,
  StateTransactionError,
  stateWritePath,
  validateStatePlan,
} from "./plan"
import { mapPathBackward, recoverStateTransactions, rollbackJournal } from "./recovery"
import {
  assertNoSymlinkParents,
  clearTransaction,
  hashScope,
  readPathTree,
  resolveStatePath,
  sha256,
  stateLockPath,
  toPosix,
  transactionBackupPath,
  transactionsDirPath,
  writeJournal,
} from "./paths"

export interface ApplyStatePlanResult {
  planId: string
  txId: string
  expectedHash: string
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

async function collectBackups(
  root: string,
  txId: string,
  operations: StateOperation[],
): Promise<StateJournalBackup[]> {
  const targets = new Set<string>()
  for (const operation of operations) {
    const writePath = stateWritePath(operation)
    if (!writePath) continue
    targets.add(writePath)
    targets.add(`${writePath}.sha256`)
  }

  const backups: StateJournalBackup[] = []
  for (const target of [...targets].sort()) {
    const sourceRel = mapPathBackward(target, operations)
    const sourceTree = await readPathTree(root, sourceRel)
    if (sourceTree.kind === "absent") {
      backups.push({ path: target, kind: "absent" })
      continue
    }
    if (sourceTree.kind === "dir") {
      throw new StateTransactionError("TARGET_EXISTS", `state file is a directory: ${sourceRel}`)
    }

    const sourceAbs = resolveStatePath(root, sourceRel)
    const backupAbs = transactionBackupPath(root, txId, target)
    await fs.mkdir(path.dirname(backupAbs), { recursive: true })
    await fs.copyFile(sourceAbs, backupAbs)
    const data = await fs.readFile(backupAbs)
    backups.push({
      path: target,
      kind: "file",
      backupPath: toPosix(path.relative(root, backupAbs)),
      sha256: sha256(data),
    })
  }
  return backups
}

async function executeOperation(root: string, operation: StateOperation): Promise<string | null> {
  if (operation.kind === "rename-dir") {
    await assertNoSymlinkParents(root, operation.from)
    await assertNoSymlinkParents(root, operation.to)
    const source = resolveStatePath(root, operation.from)
    const target = resolveStatePath(root, operation.to)
    if (await pathExists(target)) {
      throw new StateTransactionError("TARGET_EXISTS", `rename target already exists: ${operation.to}`)
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
    return null
  }

  const rel = stateWritePath(operation)
  if (!rel) return null
  await assertNoSymlinkParents(root, rel)
  const abs = resolveStatePath(root, rel)
  let data: string
  if (operation.kind === "write-spec-json") {
    data = JSON.stringify(operation.data, null, 2)
  } else if (operation.kind === "write-session") {
    data = JSON.stringify(operation.data, null, 2)
  } else {
    data = JSON.stringify(operation.data, null, 2)
  }
  await atomicWriteFile(abs, data)
  await atomicWriteFile(`${abs}.sha256`, sha256(data))
  return rel
}

export async function applyStatePlan(rootInput: string, planInput: StatePlan): Promise<ApplyStatePlanResult> {
  const root = path.resolve(rootInput)
  const plan = validateStatePlan(planInput)
  await fs.mkdir(transactionsDirPath(root), { recursive: true })

  return withLock(stateLockPath(root), async () => {
    await recoverStateTransactions(root)
    await checkStatePreconditions(root, plan.preconditions)

    const simulation = await simulateExpectedState(root, plan.scope, plan.operations)
    if (simulation.baseHash !== plan.baseHash) {
      throw new StateTransactionError("STALE_BASE", `state base hash changed for plan ${plan.planId}`)
    }
    if (simulation.expectedHash !== plan.expectedHash) {
      throw new StateTransactionError("PLAN_INVALID", `state expected hash does not match plan ${plan.planId}`)
    }

    const txId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    let backups: StateJournalBackup[]
    try {
      backups = await collectBackups(root, txId, plan.operations)
    } catch (err) {
      await clearTransaction(root, txId).catch(() => undefined)
      throw err
    }
    const journal: StateJournal = {
      format: 1,
      txId,
      planId: plan.planId,
      planHash: plan.planHash,
      baseHash: plan.baseHash,
      expectedHash: plan.expectedHash,
      state: "prepared",
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
      operations: plan.operations,
      backups,
    }
    const applying: StateJournal = {
      ...journal,
      state: "applying",
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeJournal(root, journal)
      await writeJournal(root, applying)
    } catch (err) {
      await clearTransaction(root, txId).catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      throw new StateTransactionError("APPLY_FAILED", `could not write the transaction journal: ${message}`)
    }

    const writtenPaths: string[] = []
    try {
      for (const operation of plan.operations) {
        const written = await executeOperation(root, operation)
        if (written) writtenPaths.push(written)
      }
      const actualHash = await hashScope(root, plan.scope)
      if (actualHash !== plan.expectedHash) {
        throw new StateTransactionError(
          "APPLY_FAILED",
          `state hash mismatch after apply: expected ${plan.expectedHash}, got ${actualHash}`,
        )
      }
      await writeJournal(root, {
        ...applying,
        state: "committed",
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rollingBack: StateJournal = {
        ...applying,
        state: "rolling-back",
        updatedAt: new Date().toISOString(),
        error: message,
      }
      await writeJournal(root, rollingBack).catch(() => undefined)
      try {
        await rollbackJournal(root, rollingBack)
      } catch (rollbackErr) {
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        await writeJournal(root, {
          ...rollingBack,
          state: "rollback-failed",
          updatedAt: new Date().toISOString(),
          error: `${message}; rollback: ${rollbackMessage}`,
        }).catch(() => undefined)
        throw new StateTransactionError(
          "ROLLBACK_FAILED",
          `apply failed and rollback failed for ${plan.planId}: ${rollbackMessage}`,
        )
      }
      await clearTransaction(root, txId)
      if (err instanceof StateTransactionError) throw err
      throw new StateTransactionError("APPLY_FAILED", message)
    }

    await clearTransaction(root, txId).catch(() => undefined)
    for (const rel of writtenPaths) {
      await tryAutoCommit(resolveStatePath(root, rel), root)
    }
    return { planId: plan.planId, txId, expectedHash: plan.expectedHash }
  })
}
