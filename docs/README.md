# Documentation

- [`DESIGN.md`](./DESIGN.md) — the merge queue design: the problem, the
  architecture, the queue lifecycle, and the configuration/secrets contract.
- [`adr/`](./adr) — Architecture Decision Records: the _why_ behind the stack
  and conventions. Read these before changing foundational tooling.
- [`agent.md`](./agent.md) — cloud/IaC ownership and deployment boundaries.
- [`maintenance/`](./maintenance) — operational runbooks:
  [pnpm lockfile](./maintenance/pnpm-lockfile.md) and
  [Dependabot auto-merge](./maintenance/dependabot.md).
- [`archive/`](./archive) — superseded documents. Historical record only.

## Conventions

- Decisions that shape the architecture or are costly to reverse get an ADR.
- Each ADR is immutable once `Accepted`; to change a decision, add a new ADR
  that supersedes the old one (and mark the old one `Superseded by ADR-XXXX`).
- Operational how-tos that aren't decisions go in `maintenance/`.
