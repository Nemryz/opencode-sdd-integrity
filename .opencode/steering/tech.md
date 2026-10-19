# Tech Steering: OpenCode SDD Integrity

## Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Language | TypeScript | 6.x | Native opencode plugin support, type safety for tools |
| Runtime | opencode plugin SDK | 1.x | Required for tool registration and context access |
| Validation | Zod | 4.x | Runtime schema validation for spec.json and config |
| Templates | Markdown | — | Universal format, readable by AI and humans |

## Architecture Decisions

- **ADR-001**: Tools are TypeScript files compiled at runtime by opencode, not pre-built
- **ADR-002**: Session state lives in .opencode/spec-memory/session.json per worktree
- **ADR-003**: spec.json is the source of truth for feature phase; tools fall back to file detection
- **ADR-004**: All paths and I/O are centralized in tools/shared/types.ts to eliminate duplication

## Constraints

- **Compatibility**: Must work with opencode 1.x plugin API
- **Portability**: All tools use node: prefixed imports for cross-platform support

## Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| @opencode-ai/plugin | 1.17.x | Tool registration and context API |
| zod | 4.x | Runtime schema validation |
