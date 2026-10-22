// This module owns the errno predicates that the rest of the file system layer shares.

interface ErrorWithCode extends Error {
  code: string
}

function isErrorWithCode(err: unknown): err is ErrorWithCode {
  return err instanceof Error && typeof (err as ErrorWithCode).code === "string"
}

export function isENOENT(err: unknown): boolean {
  return isErrorWithCode(err) && err.code === "ENOENT"
}

export function isEEXIST(err: unknown): boolean {
  return isErrorWithCode(err) && err.code === "EEXIST"
}

export function isESRCH(err: unknown): boolean {
  return isErrorWithCode(err) && err.code === "ESRCH"
}
