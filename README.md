# Exam Genius Backend

AI-powered exam paper generation, marking, and reference processing for [Exam Genius](https://examgenius.co.uk) — a
platform that helps UK students and teachers create curriculum-aligned practice papers for AQA, OCR, WJEC, and other
exam boards.

This service is the **compute-heavy backend** in a split architecture: the Next.js dashboard (`exam-genius`) handles
auth, billing, and UI, while this Fastify service owns long-running LLM workflows, PDF ingestion, and diagram rendering.
The two apps share a Postgres database via Prisma and communicate over authenticated HTTP.

---

## Features

| Capability                     | Description                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paper generation**           | Generates structured exam papers (questions, sub-parts, marks, topics) from course metadata and optional reference material, using versioned prompts and Zod-validated structured output. |
| **Mark scheme generation**     | Produces examiner-style mark schemes aligned to generated questions, persisted alongside the paper.                                                                                       |
| **AI marking**                 | Marks student attempts question-by-question with scores, examiner notes, grade bands, and summaries.                                                                                      |
| **Legacy paper parsing**       | Converts older free-text paper content into the structured JSON block format used by the current pipeline.                                                                                |
| **Figure & diagram rendering** | Raster-only async pipeline: OpenRouter image-model chain → raster bytes → UploadThing CDN; ready figures persist `image_url` (inline `svg` cleared). Legacy inline SVG from older data may still display in the dashboard. |
| **Reference extraction**       | Ingests uploaded PDFs (question papers, mark schemes, examiner reports), extracts text, and stores deduplicated reference records.                                                        |
| **Runtime model routing**      | Per-flow LLM model selection (`paper_generate`, `mark_scheme`, `attempt_marking`, etc.) loaded from Postgres with a 60s TTL cache and safe defaults.                                      |
| **Resilience**                 | Background sweeps recover attempts stuck in `marking` and figures stuck in `pending` after crashes or deploys.                                                                            |

---

## Tech Stack

| Layer                   | Technologies                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime & framework** | Node.js 22+, [Fastify](https://fastify.dev) 5, TypeScript 5.9                                                                                 |
| **Build & monorepo**    | [Nx](https://nx.dev) 21, esbuild, pnpm 10                                                                                                     |
| **Database**            | PostgreSQL via [Prisma](https://prisma.io) 7 + [Prisma Accelerate](https://www.prisma.io/accelerate) (connection pooling)                     |
| **AI / LLM**            | OpenAI API (structured outputs, `zodResponseFormat`), [OpenRouter](https://openrouter.ai) for multi-model figure rasterisation                |
| **Validation**          | Zod 4 schemas for request bodies, LLM responses, and question block structures                                                                |
| **File storage**        | [UploadThing](https://uploadthing.com) for rendered figure assets                                                                             |
| **Observability**       | Winston logging, optional [Axiom](https://axiom.co) ingest for structured AI telemetry (`logAiStructured`), PostHog server-side feature flags |
| **Deployment**          | [Railway](https://railway.app) (Nixpacks, health checks, auto-restart)                                                                        |
| **Secrets**             | [Doppler](https://doppler.com) for environment management                                                                                     |
| **Testing**             | Jest (unit), Vitest (integration, e.g. figure raster pipeline), Nx e2e project                                                                |

---

## Architecture

### Split backend pattern

The dashboard app delegates expensive, stateful AI work to this service rather than running it inside Next.js serverless
functions. Benefits:

- **Long-running jobs** — paper generation and marking are not constrained by Vercel function timeouts.
- **Independent scaling** — the backend can be scaled and deployed separately on Railway.
- **Shared data model** — both apps use the same Prisma schema (papers, questions, attempts, references, LLM config).

All `/server/*` routes require a shared secret header (`x-exam-genius-secret`) so only the trusted dashboard can invoke
them.

```
┌─────────────────────┐         x-exam-genius-secret          ┌──────────────────────────┐
│  exam-genius        │  ─────────────────────────────────► │  exam-genius-backend     │
│  (Next.js / tRPC)   │         POST /server/paper/*        │  (Fastify on Railway)    │
│  Clerk · Stripe     │         POST /server/answer/*       │                          │
└─────────┬───────────┘         POST /server/references/*   └────────────┬─────────────┘
          │                                                               │
          └─────────────────────── Prisma Accelerate ───────────────────────┘
                                         PostgreSQL
```

### Module layout

```
src/app/
├── modules/
│   ├── paper/          # Generation, mark schemes, figures, legacy parse
│   ├── answer/         # Attempt marking + stale recovery
│   └── reference/      # PDF text extraction
├── prompts/            # Versioned LLM prompt templates
├── plugins/            # Fastify plugins (sensible defaults)
├── routes/             # Public routes (health-adjacent)
└── utils/              # Prisma, OpenAI, OpenRouter, logging, PostHog
```

### Key design decisions

- **Structured LLM output** — Papers and mark schemes are parsed through Zod schemas before persistence, reducing silent
  data corruption from free-form model text.
- **Block-based question bodies** — Questions store content as typed JSON blocks (`text`, `math`, `table`, `figure`),
  enabling rich rendering and targeted figure pipelines.
- **Database-driven model config** — `LlmModelConfig` rows let you swap models per flow without redeploying; a TTL cache
  keeps hot paths fast.
- **Prompt versioning** — Each AI flow records its prompt version alongside results for traceability and A/B analysis.
- **Feature flags** — Figure generation is gated via PostHog server-side evaluation, with a hard kill switch via
  `DISABLE_FIGURE_GENERATION`.
- **Modular Prisma schema** — Domain schemas live in `prisma/schemas/` and merge via `prismerge` into a single
  `schema.prisma`.

---

## API Endpoints

Routes under `/server` require the `x-exam-genius-secret` header. `GET /healthcheck` is the exception: mounted at the app root (not under `/server`) for deploy liveness probes and requires no auth.

| Method | Path                                 | Purpose                                         |
| ------ | ------------------------------------ | ----------------------------------------------- |
| `GET`  | `/healthcheck`                       | Liveness probe (root path, no `x-exam-genius-secret`) |
| `POST` | `/server/paper/generate`             | Generate a structured exam paper                |
| `POST` | `/server/paper/generate-mark-scheme` | Generate mark scheme for a paper                |
| `POST` | `/server/paper/generate-figures`     | Render pending figure blocks                    |
| `POST` | `/server/paper/replace-figure`       | Manual figure replacement                       |
| `POST` | `/server/paper/parse-legacy`         | Parse legacy paper content to structured format |
| `POST` | `/server/answer/mark`                | Mark a submitted attempt                        |
| `POST` | `/server/references/extract`         | Extract text from an uploaded PDF reference     |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 22.12.0
- **pnpm** 10.x (`corepack enable`)
- Access to the shared Postgres database (Accelerate URL for runtime, direct URL for migrations)
- OpenAI API key and backend shared secret (minimum to boot)

### Environment variables

| Variable                               | Required                   | Description                                                 |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `PORT`                                 | Yes                        | HTTP port (Railway sets this automatically)                 |
| `OPENAI_API_KEY`                       | Yes                        | OpenAI API access                                           |
| `BACKEND_SHARED_SECRET`                | Yes                        | Shared auth secret for `/server` routes                     |
| `DATABASE_URL`                         | Yes                        | Prisma Accelerate connection string (`prisma+postgres://…`) |
| `DIRECT_DATABASE_URL`                  | For migrations             | Direct Postgres URL for Prisma CLI                          |
| `OPENROUTER_API_KEY`                   | For figure raster fallback | OpenRouter API key                                          |
| `UPLOADTHING_TOKEN`                    | For figure uploads         | UploadThing server token                                    |
| `AXIOM_TOKEN` / `AXIOM_DATASET`        | Optional                   | Structured AI telemetry ingest                              |
| `NEXT_PUBLIC_POSTHOG_KEY`              | Optional                   | PostHog project key for feature flags                       |
| `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` | Optional                   | Local evaluation of feature flags                           |
| `DISABLE_AS_LEVEL_EXAM_FLOW`           | Optional                   | When `true`, blocks AS-level generation and marking         |
| `DISABLE_FIGURE_GENERATION`            | Optional                   | Hard kill switch for figure pipeline                        |
| `LOG_LEVEL`                            | Optional                   | Winston log level override                                  |

Pull secrets from Doppler for local development:

```bash
pnpm run create-env-file:backend
```

### Install & run

```bash
pnpm install
pnpm prisma:sync          # merge schemas + generate Prisma client
pnpm nx:serve:backend     # dev server with watch + debugger on :9229
```

Production build and start:

```bash
pnpm run nx:build:backend:prod
pnpm run nx:serve:backend:prod
```

---

## Development

### Common commands

```bash
pnpm nx:serve:backend              # Dev server
pnpm build                         # Prisma generate + production build
pnpm test                          # Jest unit tests
pnpm test:vitest                   # Vitest (integration tests)
pnpm nx lint exam-genius-backend   # ESLint
pnpm nx graph                      # Visualise project dependencies
```

### Database

Schemas are split across `prisma/schemas/` and merged with prismerge:

```bash
pnpm prisma:merge                  # merge only
pnpm prisma:sync                 # merge + generate client
npx prisma migrate dev             # run migrations (uses DIRECT_DATABASE_URL)
```

### Testing strategy

- **Jest** — unit tests for controllers, services, and utilities.
- **Vitest** — integration tests for the figure raster pipeline (requires `OPENROUTER_API_KEY` and `UPLOADTHING_TOKEN`
  for live runs).
- **e2e** — Nx e2e project for HTTP-level smoke tests.

---

## Deployment

The service deploys to **Railway** via Nixpacks:

- **Build:** `pnpm run nx:build:backend:prod`
- **Start:** `pnpm run nx:serve:backend:prod`
- **Health check:** `GET /healthcheck`
- **Restart policy:** on failure, up to 10 retries

Configuration lives in `railway.json` and `nixpacks.toml`.

---

## Contributing

Contributions are welcome. When opening a pull request:

1. Follow existing TypeScript and formatting conventions (tabs, single quotes, 120-char line width — see `.prettierrc`).
2. Run `pnpm nx lint exam-genius-backend` and `pnpm test` before submitting.
3. Regenerate the Prisma client after schema changes: `pnpm prisma:sync`.
4. If you add or materially change an LLM prompt, update the prompt registry in the companion `exam-genius` repo
   (`apps/dashboard-app/misc/gpt-prompts.md`) and emit `logAiStructured` events for new AI flows.
5. Keep changes focused — this service handles AI orchestration; auth, billing, and UI belong in the dashboard app.

For agent/AI assistant context, see `AGENTS.md` and `CLAUDE.md`.

---

## License

MIT — see `package.json`.
