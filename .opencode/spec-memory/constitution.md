# Project Constitution

> Governing principles for opencode-sdd-integrity

## Article I: Simplicity First

Every feature must be built with minimal dependencies. Max 3 top-level projects. No abstraction without immediate need.

Why: Models pattern-match against millions of codebases and tend to over-engineer. Simplicity constraints counter this bias. Explicit limits force deliberate decisions rather than automatic complexity.

## Article II: Test-First Imperative (NON-NEGOTIABLE)

Tests must be written before implementation code. Every user story requires at minimum one integration test covering the happy path.

Why: Writing tests after code lets the agent optimize for false positives. Tests written first define real acceptance criteria. Integration tests catch the systemic failures that unit tests miss in AI-generated code.

## Article III: Explicit Over Implicit

Configuration is explicit. Auto-discovery is permitted when visible and confirmed by the user before use. No hidden global state. Dependencies are injected, not imported.

Why: AI agents default to implicit patterns (auto-loading, ambient singletons) because training data favors brevity. Explicit configuration makes decisions visible, auditable, and reversible. When auto-discovery is used, detected context must be shown to the user for confirmation, ensuring no silent decisions are made.

## Article IV: Integration-First Testing

Tests run against real dependencies (database, API, filesystem) not mocks. Use testcontainers or equivalent for external services.

Why: Mock-heavy tests pass on AI-generated code but fail in production. Real dependencies catch integration bugs that mocks hide. This is the single highest-ROI practice for AI-assisted development.

## Article V: Quality Gates

- Lint must pass before commit
- Tests must pass before merge
- No dead code, no commented-out code, no TODOs in main

Why: AI agents leave behind scaffolding code, dead comments, and placeholder TODOs. Automated gates catch these before they reach main. Each gate is a forcing function for agent discipline.

## Article VI: Documentation as Code

Specs, plans, and decisions live in the repository alongside code. Update docs when behavior changes.

Why: Documentation that lives separately from code gets stale instantly. Co-located, version-controlled docs stay accurate because agents read them before writing code. Treat docs as code means they get the same review discipline.

---

### Project-specific notes

- Simplicity: [add project-specific constraints]
- Test approach: [describe testing tools / patterns]
- Explicit config: [document configuration approach]
- Integration tests: [document integration test setup]
- Quality tools: [list lint/format/type-check tools]
- Docs: [document any doc conventions]
