# OpenCode SDD Niche Positioning

This document compares opencode SDD Kit with the other spec-driven development kits a user could adopt inside OpenCode, so the comparison stays with the code instead of living in a chat log.
All numbers were collected on 2026-10-19 from public repositories, the npm registry, and PyPI.
Competitor capabilities are quoted from their own public documentation, and the statements about this toolkit come from the capability verification described near the end of the document.

## The niche map

Three groups matter when a user chooses an SDD workflow for OpenCode.
**OpenCode-native kits** are built for this runtime only, and four are relevant today.
**Multi-harness toolkits** are agent-agnostic projects that support OpenCode as one integration among many, and four matter by adoption.
**Adjacent add-ons** complement a workflow instead of replacing it, such as Beads, Basic Memory, TDD Guard, Micode, and the OpenSpec planning bridge plugin.

## OpenCode-native kits

| Kit | Stars | Weekly installs | Distribution | State and recovery | Gates and enforcement | Verification |
|-----|-------|-----------------|--------------|--------------------|-----------------------|--------------|
| opencode SDD Kit (this repository) | 1 | Not on npm | Shell installer plus plugin wiring | Zod-validated session and spec state with atomic writes and hashes, checksummed backups, verifiable snapshots with restore drills and journal | Per-artifact approvals with explicit confirmation, file guard that blocks editor and shell writes to state, per-phase pre-validation | 2,990 tests, CI on three operating systems, install and smoke end-to-end jobs, Stryker mutation testing, V1 and V2 wiring from one package with V2 verified end to end in a real 2.0.32 runtime |
| GoopSpec | 50 | 1 | npm plugin and Bun CLI | SQLite state, checkpoints, background daemon, cross-project memory | Two mandatory human contract gates, a specialist agent orchestration layer | 1,660 tests as published, dual V1 and V2 plugin contract declared, repository quiet since 2026-08-12 |
| Conductor | 131 | 54 | npm plugin (v1.32) | Per-track metadata file and git-aware revert | Context, spec, plan, implement lifecycle without a state integrity layer | No visible suite, last push 2026-03-02 |
| opencode-sdd | 4 | 14 | npm plugin with an install wizard | Markdown artifacts without a documented recovery layer | Six subagents, a clean session per phase, retry-capped auto-implement, recorded human decisions | Mock-LLM end-to-end suite plus manual QA with frontier models, active |

## Multi-harness toolkits with OpenCode support

| Toolkit | Stars | Weekly installs | OpenCode integration | Enforcement model |
|---------|-------|-----------------|----------------------|-------------------|
| Spec Kit (GitHub) | 141,883 | 31,295 on PyPI | Commands under `.opencode/commands` plus a generated TypeScript plugin that maps tool and chat lifecycle events | Documentation, templates, and configurable hooks, without an edit guard or resilient state |
| OpenSpec | 72,400 | 421,448 on npm | `openspec init` commands plus a community sidebar plugin | Documents and commands under an explicit philosophy against rigid phase gates, cross-repository stores in beta |
| BMAD | 54,300 | 13,978 on npm | Agents and commands in v6, one command per skill in v7 | Documentation and workflows, with Python and uv required for setup |
| cc-sdd | 3,722 | 3,416 on npm | Agent skills for eight harnesses including OpenCode | Documentation and skills with steering context and autonomous implementation after approval |

## Where this toolkit stands

Enforcement and state integrity are the strongest in the niche, because no other kit documents a guard that blocks both editor writes and shell redirects, checksummed snapshots with restore drills, a crash-safe restore journal, self-healing audits, or mutation testing of the toolkit itself.
The engineering evidence is top two, with only GoopSpec publishing a comparable suite and none of the others combining three-operating-system CI with install and smoke end-to-end jobs.
Adoption is the weakest axis, because the native kits hold single-digit to low-hundreds stars while the multi-harness toolkits hold thousands to over one hundred thousand, so the position is capability without reach.
Process breadth sits at parity with the native kits and behind the multi-harness toolkits, which ship convergence, checklists, archiving, cross-repository stores, and extension catalogs that this toolkit does not have yet.

The claim of being better than most of the niche holds under enforcement, verification, and state integrity, and it does not hold under adoption or process breadth.
The honest summary is first by rigor and last by reach, which is a distribution problem more than an engineering problem.

## Gaps and follow-ups

1. Distribution. Every native competitor installs through npm with a wizard or CLI, and this toolkit uses a shell script, so an npm-based installer is planned as part of the V2 formalization.
2. Visibility. The toolkit is not listed in awesome-opencode or in third-party directories, so a listing request, a demo, and a short comparison section would close part of the gap.
3. Memory across features. Steering context covers project knowledge, but nothing carries lessons from finished features into the next one, which GoopSpec, BMAD, and the memory add-ons all ship in some form.
4. Process breadth. Convergence and checklists from Spec Kit and exploration and archiving from OpenSpec are the most used parts of those kits that this toolkit lacks.

## Verification of this toolkit's claims

The capability run on 2026-10-19 used a real OpenCode 2.0.32 runtime with the toolkit installed through its own installer, drove a full feature lifecycle from constitution to implementation through the model, exercised every tool the kit shipped in that build, and confirmed the guard blocks both a direct editor write and a shell redirect against protected state.
Two runtime findings from that run became regression entries R-13 and R-14 in `docs/regressions.md`.
The suite totals and CI jobs named above live in the badges and workflows of this repository.

## Sources

- https://github.com/ameshkov/opencode-sdd
- https://github.com/hffmnnj/goopspec
- https://github.com/derekbar90/opencode-conductor
- https://github.com/NocturnLabs/opencode-conductor
- https://github.com/github/spec-kit
- https://github.com/Fission-AI/OpenSpec
- https://github.com/bmad-code-org/BMAD-METHOD
- https://github.com/gotalab/cc-sdd
- https://api.npmjs.org/downloads/point/last-week/opencode-sdd
- https://api.npmjs.org/downloads/point/last-week/opencode-conductor-plugin
- https://api.npmjs.org/downloads/point/last-week/opencode-goopspec
- https://api.npmjs.org/downloads/point/last-week/@fission-ai/openspec
- https://api.npmjs.org/downloads/point/last-week/bmad-method
- https://api.npmjs.org/downloads/point/last-week/cc-sdd
- https://pypistats.org/api/packages/specify-cli/recent
- https://yigitkonur.com/atlas/spec-driven-development/frameworks

Weekly download figures cover the week of 2026-10-10.
Stars and downloads are point-in-time values that will drift, so the tables are a dated photograph rather than a live feed.
