// This module is the compatibility facade for the file system layer, so existing imports keep working after the split.

export * from "./errors"
export * from "./paths"
export * from "./checksums"
export * from "./locks"
export * from "./atomic"
export * from "./backups"
export * from "./warnings"
export * from "./frontmatter"
export * from "./diagnostics"
export * from "./state/session"
export * from "./state/spec"
export * from "./state/config"
