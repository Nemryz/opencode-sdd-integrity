// This module owns the corruption warnings that readers surface without failing the whole command.

export interface CorruptionWarning {
  file: string
  message: string
  timestamp: number
  suggestion?: string
}

export let corruptionWarnings: CorruptionWarning[] = []

export function clearCorruptionWarnings(): void {
  corruptionWarnings = []
}

export function pushCorruptionWarning(fp: string, errorMsg: string, suggestion?: string): void {
  const existing = corruptionWarnings.find(w => w.file === fp && w.message === errorMsg)
  if (existing) return
  const warn: CorruptionWarning = { file: fp, message: errorMsg, timestamp: Date.now(), suggestion }
  corruptionWarnings.push(warn)
  console.warn(`[SDD] Corruption detected in ${fp}: using defaults. ${errorMsg}`)
  if (suggestion) {
    console.warn(`[SDD] ${suggestion}`)
  }
}
