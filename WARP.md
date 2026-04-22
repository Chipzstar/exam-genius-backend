# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Workspace Overview

This is an **Nx monorepo** (v19.8.9) containing a Node.js/Fastify backend application for ExamGenius, a service that generates AI-powered practice exams for A-level subjects.

**Tech Stack:**
- **Framework**: Fastify (Node.js)
- **Database**: Prisma ORM with PostgreSQL
- **Language**: TypeScript 5.5.4
- **Build**: Nx with esbuild
- **Testing**: Jest
- **Package Manager**: pnpm (v10.8.0)
- **AI**: OpenAI GPT-4
- **Logging**: Logtail/Winston
- **Environment**: Doppler (production/staging)

## Essential Commands

### Development
```bash
# Start dev server (default: http://localhost:3000)
nx serve exam-genius-backend
# or
pnpm start

# Build application
nx build exam-genius-backend
# or (includes Prisma generation)
pnpm build
```

### Testing & Quality
```bash
# Run tests
nx test exam-genius-backend

# Run specific test file
nx test exam-genius-backend --testFile=src/app/app.spec.ts

# Run tests in watch mode
nx test exam-genius-backend --watch

# Run E2E tests
nx e2e e2e

# Lint
nx lint exam-genius-backend

# Run tests with coverage
nx test exam-genius-backend --coverage
```

### Database Operations
```bash
# Generate Prisma client (ALWAYS run after schema changes)
npx prisma generate

# Run migrations
npx prisma migrate dev

# Open Prisma Studio
npx prisma studio

# Create migration
npx prisma migrate dev --name <migration_name>
```

### Nx Utilities
```bash
# View project dependency graph
nx graph

# See affected projects after changes
nx affected:graph

# Build only affected projects
nx affected:build

# Show project details
nx show project exam-genius-backend

# Clear Nx cache (useful for troubleshooting)
nx reset
```

### Environment Setup
```bash
# Create local .env from Doppler (local config)
pnpm run create-env-file:backend

# Create production .env from Doppler (production config)
pnpm run create-env-file:backend:prod
```

## Architecture

### Application Entry Point
- **src/main.ts**: Fastify server initialization, plugin registration, and route setup
- Server listens on localhost:3000 (dev) or 0.0.0.0:PORT (production)
- Environment validation via `@fastify/env` (requires `OPENAI_API_KEY`)

### Core Structure
```
src/app/
├── modules/          # Feature modules organized by domain
│   └── paper/        # Paper generation module
│       ├── paper.controller.ts  # Business logic for paper generation
│       └── paper.route.ts       # Route definitions
├── plugins/          # Fastify plugins (e.g., sensible)
├── routes/           # Base routes (auto-loaded via @fastify/autoload)
│   └── root.ts
└── utils/            # Shared utilities
    ├── gpt.ts        # OpenAI client configuration
    ├── logtail.ts    # Logging setup
    └── prisma.ts     # Prisma client instance
```

### Module Pattern
Each feature module should follow this structure:
- **\*.controller.ts**: Contains business logic and async operations
- **\*.route.ts**: Defines Fastify routes and registers controller handlers
- Keep modules isolated and domain-focused

### Plugin Auto-loading
- Fastify plugins in `src/app/plugins/` are auto-loaded via `@fastify/autoload`
- Routes in `src/app/routes/` are auto-loaded similarly
- Module-specific routes (e.g., paper routes) are registered in `main.ts` with prefix

### Database Schema Organization
Prisma schemas are **modular** using prismerge:
- **prisma/schema.prisma**: Auto-generated merged schema (DO NOT EDIT)
- **prisma/schemas/**: Source schema files
  - `base.prisma`: Generator and datasource config
  - `course.prisma`: Course model and enums
  - `paper.prisma`: Paper model and enums
  - `user.prisma`: User model and enums

**After editing any schema file**: Run `npx prisma generate` to regenerate the client.

### Key Models
- **User**: Auth via Clerk, Stripe subscription management
- **Course**: Links users to exam subjects (Subject, ExamBoard, year_level)
- **Paper**: AI-generated practice papers (content stored as HTML)

## Important Development Notes

### Prisma Client Generation
The Prisma client **must** be regenerated after any schema changes. Build scripts automatically handle this, but for manual changes:
```bash
npx prisma generate
```

### Environment Variables
Required variables (managed via Doppler):
- `DATABASE_URL`: PostgreSQL connection string
- `DATABASE_URL_UNPOOLED`: Direct PostgreSQL connection (for migrations)
- `OPENAI_API_KEY`: OpenAI API authentication
- Additional Stripe and Clerk variables (check .env.example if available)

### Logging
- Use the Winston logger from `src/app/utils/logtail.ts`
- Logs are sent to Logtail for production monitoring
- Console logging is used alongside structured logging

### Error Handling
- Controllers should catch errors and return appropriate HTTP status codes
- Use Fastify's error handling patterns
- Paper generation failures set paper status to 'failed' in database

### Nx Cloud
- Remote caching is enabled for faster builds
- Affected commands only run tasks on changed projects
- Access token stored in `nx.json`

## Production Build

```bash
# Build for production (skips Nx cache)
pnpm run nx:build:backend:prod

# Run production build
pnpm run nx:serve:backend:prod
# or
node dist/exam-genius-backend/main.js
```

## Troubleshooting

### Build failures
1. Regenerate Prisma client: `npx prisma generate`
2. Clear Nx cache: `nx reset`
3. Reinstall dependencies: `rm -rf node_modules && pnpm install`

### Type errors after schema changes
- Ensure Prisma client was regenerated
- Check TypeScript version compatibility (5.5.4)

### Database connection issues
- Verify `DATABASE_URL` in .env
- Check if database migrations are up to date: `npx prisma migrate dev`

### Test failures
- Ensure environment variables are properly set
- Check if test database is configured correctly

## Migration History

This workspace was migrated from Nx 16.5.0 to 19.8.9 following an incremental path. All `@nrwl/*` packages have been replaced with `@nx/*` packages.
