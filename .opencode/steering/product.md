# Product Steering: OpenCode SDD Integrity

## Purpose

Provide a Spec-Driven Development workflow system for opencode users. The kit delivers structured phases, artifact templates, TypeScript tools, and skill instructions that guide AI agents from specification through implementation with governance gates.

## Users

- **Primary users**: Developers using opencode who want a structured SDD workflow
- **Secondary users**: Teams adopting spec-driven practices for AI-assisted development
- **Stakeholders**: opencode community, contributors to the kit

## Success Metrics

- **Feature adoption**: Users follow the spec/plan/tasks/impl workflow without errors
- **Artifact consistency**: spec.json phase matches actual files on disk
- **Zero manual fixes**: The audit tool and phase gates catch all state inconsistencies

## Boundaries

- **In scope**: SDD workflow orchestration, artifact scaffolding, phase tracking, audit, review
- **Out of scope**: Code generation, deployment pipelines, CI/CD integration, project-specific templates

## Assumptions

- Users have opencode installed and configured
- Users are familiar with markdown and basic terminal usage
- The kit lives in ~/.config/opencode/ and is auto-discovered by opencode
