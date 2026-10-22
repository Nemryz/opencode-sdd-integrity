// This module owns the hashes and checksum sidecars that let a reader notice a truncated or edited state file.

import crypto from "node:crypto"
import fs from "node:fs/promises"
import { atomicWriteFile } from "./atomic"

export function computeSha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

export function stripBom(data: string): string {
  return data.charCodeAt(0) === 0xfeff ? data.slice(1) : data
}

export async function writeChecksumFile(bakPath: string, data: string): Promise<void> {
  const hash = computeSha256(data)
  await atomicWriteFile(`${bakPath}.sha256`, hash)
}

export async function verifyChecksum(bakPath: string, data: string): Promise<boolean> {
  try {
    const stored = await fs.readFile(`${bakPath}.sha256`, "utf-8")
    const computed = computeSha256(data)
    return stored.trim() === computed
  } catch {
    return false
  }
}

export async function verifyFileChecksum(fp: string): Promise<boolean> {
  try {
    const checksumPath = `${fp}.sha256`
    const stored = await fs.readFile(checksumPath, "utf-8")
    const data = await fs.readFile(fp, "utf-8")
    const computed = computeSha256(data)
    return stored.trim() === computed
  } catch {
    return true
  }
}

export async function writeFileChecksum(fp: string): Promise<void> {
  try {
    const data = await fs.readFile(fp, "utf-8")
    const hash = computeSha256(data)
    await atomicWriteFile(`${fp}.sha256`, hash)
  } catch {
    // fail silently
  }
}

export async function verifyLiveFileChecksum(fp: string): Promise<boolean> {
  try {
    await fs.access(fp)
  } catch {
    return false
  }
  try {
    const data = await fs.readFile(fp, "utf-8")
    const stored = await fs.readFile(`${fp}.sha256`, "utf-8")
    const computed = computeSha256(data)
    return stored.trim() === computed
  } catch {
    return true
  }
}
