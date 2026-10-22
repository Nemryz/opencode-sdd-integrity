// This module owns the rollback and startup recovery that makes an interrupted transaction safe to repeat.

import path from "node:path"
import fs from "node:fs/promises"
import { atomicWriteFile } from "../atomic"
import { withLock } from "../locks"
import type { StateJournal, StateOperation } from "../schemas"
import { StateTransactionError } from "./plan"
import {
  clearTransaction,
  listTransactionIds,
  readJournal,
  resolveStatePath,
  sha256,
  stateLockPath,
  transactionDirPath,
  transactionsDirPath,
  writeJournal,
} from "./paths"

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

export function mapPathBackward(rel: string, operations: StateOperation[]): string {
  let current = rel
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]
    if (operation.kind !== "rename-dir") continue
    if (current === operation.to) {
      current = operation.from
    } else if (current.startsWith(`${operation.to}/`)) {
      current = `${operation.from}${current.slice(operation.to.length)}`
    }
  }
  return current
}

export async function rollbackJournal(root: string, journal: StateJournal): Promise<void> {
  for (const operation of [...journal.operations].reverse()) {
    if (operation.kind !== "rename-dir") continue
    const source = resolveStatePath(root, operation.from)
    const target = resolveStatePath(root, operation.to)
    const sourceExists = await pathExists(source)
    const targetExists = await pathExists(target)
    if (!sourceExists && targetExists) {
      await fs.rename(target, source)
      continue
    }
    // Directory renames are atomic: if the source still exists, the rename never
    // completed. A target that also exists was created by a concurrent actor
    // (for example an archive collision) and must not be removed here.
    if (sourceExists) continue
    if (!targetExists) {
      throw new Error(`rollback cannot find rename source or target: ${operation.from}`)
    }
  }

  const transactionRoot = transactionDirPath(root, journal.txId)
  for (const backup of [...journal.backups].reverse()) {
    const targetRel = mapPathBackward(backup.path, journal.operations)
    const target = resolveStatePath(root, targetRel)
    if (backup.kind === "absent") {
      await fs.rm(target, { force: true })
      continue
    }
    if (!backup.backupPath) {
      throw new Error(`rollback backup path is missing for ${backup.path}`)
    }
    const backupAbs = resolveStatePath(root, backup.backupPath)
    if (!backupAbs.startsWith(`${transactionRoot}${path.sep}`)) {
      throw new Error(`rollback backup path escapes the transaction: ${backup.backupPath}`)
    }
    const data = await fs.readFile(backupAbs)
    if (backup.sha256 && sha256(data) !== backup.sha256) {
      throw new Error(`rollback backup checksum mismatch for ${backup.path}`)
    }
    await atomicWriteFile(target, data)
  }
}

export interface StateTransactionSummary {
  txId: string
  state: StateJournal["state"] | "unreadable"
  planId?: string
  startedAt?: string
  error?: string
}

export async function inspectStateTransactions(root: string): Promise<StateTransactionSummary[]> {
  const summaries: StateTransactionSummary[] = []
  for (const txId of await listTransactionIds(root)) {
    const journal = await readJournal(root, txId)
    if (!journal) {
      summaries.push({ txId, state: "unreadable" })
      continue
    }
    summaries.push({
      txId,
      state: journal.state,
      planId: journal.planId,
      startedAt: journal.startedAt,
      error: journal.error,
    })
  }
  return summaries.sort((left, right) => {
    return (left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.txId.localeCompare(right.txId)
  })
}

export async function recoverStateTransactions(root: string): Promise<{ recovered: string[] }> {
  await fs.mkdir(transactionsDirPath(root), { recursive: true })
  return withLock(stateLockPath(root), async () => {
    const ids = await listTransactionIds(root)
    const journals: StateJournal[] = []
    for (const id of ids) {
      const journal = await readJournal(root, id)
      if (!journal) {
        await clearTransaction(root, id)
        continue
      }
      journals.push(journal)
    }
    journals.sort((left, right) => {
      return left.startedAt.localeCompare(right.startedAt) || left.txId.localeCompare(right.txId)
    })

    const recovered: string[] = []
    for (const journal of journals) {
      if (journal.state === "committed") {
        await clearTransaction(root, journal.txId)
        recovered.push(journal.txId)
        continue
      }
      if (journal.state === "rollback-failed") {
        throw new StateTransactionError(
          "ROLLBACK_FAILED",
          `transaction ${journal.txId} requires manual repair before another apply`,
        )
      }

      const rollingBack: StateJournal = {
        ...journal,
        state: "rolling-back",
        updatedAt: new Date().toISOString(),
      }
      await writeJournal(root, rollingBack)
      try {
        await rollbackJournal(root, rollingBack)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await writeJournal(root, {
          ...rollingBack,
          state: "rollback-failed",
          updatedAt: new Date().toISOString(),
          error: message,
        })
        throw new StateTransactionError(
          "ROLLBACK_FAILED",
          `transaction ${journal.txId} failed to roll back: ${message}`,
        )
      }
      await clearTransaction(root, journal.txId)
      recovered.push(journal.txId)
    }
    return { recovered }
  })
}
