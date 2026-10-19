# Structure Steering: OpenCode SDD Integrity

## Repository Layout

```
~/.config/opencode/
  AGENTS.md              Workflow orchestration and phase definitions
  agents/                Custom agent definitions (spec.md)
  commands/              CLI command handlers (9 markdown files)
  skills/                Skill instructions (6 skills + shared rules)
  tools/                 TypeScript plugin tools (5 tools + shared module)
  templates/             Artifact templates (12 files)
  docs/                  Reference documentation
  .opencode/
    spec-memory/         Session state, constitution, config
    steering/            Steering context (product, tech, structure)
```

## Code Conventions

- **Naming**: kebab-case for directories and files, PascalCase for TypeScript types
- **Formatting**: Standard TypeScript with @opencode-ai/plugin SDK patterns
- **Imports**: Use node: prefix for built-in modules, relative imports for project modules

## Patterns

- **Tool pattern**: Each tool exports default via tool() with description, args schema, execute handler
- **Skill pattern**: Each skill is a SKILL.md with frontmatter metadata and step-by-step instructions
- **Command pattern**: Each command is a markdown file with frontmatter description and task instructions

## Testing Strategy

- **Unit tests**: Not yet implemented (tools are tested via opencode runtime)
- **Integration tests**: Run tools against real project directories to verify phase transitions
- **Manual tests**: Run /status, /audit, /clean to verify workflow state
