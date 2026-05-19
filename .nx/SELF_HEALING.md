# Self-Healing Configuration

Instructions for the Nx Cloud Self-Healing CI agent when fixing failures in **exam-genius-backend**.

## Confidence Rules

- Fixes involving LLM prompts, marking logic, or paper generation should require high confidence.
- Formatting and lint auto-fixes can be applied with medium confidence.

## Off-Limits Areas

- `prisma/schema.prisma` — merged output; edit sources under `prisma/schemas/` via `pnpm prisma:merge` instead.
- `node_modules/`, `dist/`, and generated Prisma client output — never modify directly.

## Fix Preferences

- Prefer updating ESLint rules over adding `eslint-disable` comments.
- For type errors, prefer explicit types over `any`.
- Run `pnpm prisma:sync` (or `prisma:merge` + `prisma generate`) when Prisma client is out of date; do not hand-edit generated client files.
- For lint failures, try `nx affected -t lint --fix` or project-level lint with fix where supported.

## Context

- Package manager: **pnpm** (not npm). Use `pnpm install --frozen-lockfile` in CI.
- Default branch: **master** (`nx.json` `defaultBase`).
- Build requires Prisma client: `pnpm prisma:sync` before `nx build`.
- See `AGENTS.md` and `README.md` for workspace layout, Nx commands, and env vars (`DATABASE_URL`, `DIRECT_DATABASE_URL`, Doppler).
