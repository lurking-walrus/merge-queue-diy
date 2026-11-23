# AGENTS.md

This project's agent guidance lives in [`CLAUDE.md`](./CLAUDE.md) — read it first.

Quick pointers for any coding agent:

- **What this is:** a merge queue GitHub App. Design in `docs/DESIGN.md`.
- **Before committing:** `pnpm check:fix && pnpm test`. A commit hook enforces this.
- **`src/core` stays pure** — no I/O, no clock. New behaviour gets a scenario
  in `src/sim/scenarios.test.ts`.
- **Public repository:** no account ids, org names, domains, keys or tokens in
  source, tests or docs. Add new env vars to both `src/env.ts` and `.env.example`.
- **Foundational changes:** read the relevant ADR in `docs/adr/` first; add a
  superseding ADR when you change a decision.
- **Archive:** `docs/archive/` is historical record, not current truth.
- **Infrastructure:** read `docs/agent.md` before adding cloud resources.
