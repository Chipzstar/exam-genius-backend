# AI Agents Working Instructions

This file provides instructions for AI coding assistants (like Cursor, GitHub Copilot, Claude Code, etc.) when working
with this Nx workspace.

## Workspace Type

Nx Monorepo (Version 19.8.9)

## Quick Context

-   **Primary Project**: exam-genius-backend (Node.js/Fastify backend)
-   **Package Manager**: pnpm
-   **Build Tool**: Nx with esbuild
-   **Database**: Prisma ORM
-   **Cloud**: Nx Cloud enabled

## Key Capabilities

### Understanding Project Structure

This workspace uses Nx, which provides:

-   Project graph for understanding dependencies
-   Smart caching for faster builds
-   Code generation tools
-   Affected command detection

### Common Tasks

#### 1. Building

```bash
nx build exam-genius-backend
# or with Prisma generation
pnpm run build
```

#### 2. Running Development Server

```bash
nx serve exam-genius-backend
# or
pnpm start
```

#### 3. Testing

```bash
nx test exam-genius-backend
nx e2e e2e
```

#### 4. Linting

```bash
nx lint exam-genius-backend
```

#### 5. Database Operations

```bash
npx prisma generate
npx prisma migrate dev
npx prisma studio
```

### Project Graph Commands

```bash
# View project dependencies
nx graph

# See affected projects (after changes)
nx affected:graph

# List all projects
nx show projects

# Show specific project details
nx show project exam-genius-backend
```

## Code Generation

### Using Nx Generators

```bash
# Generate a new library
nx g @nx/node:library my-lib

# Generate a new application
nx g @nx/node:application my-app
```

## Architecture Guidelines

### File Organization

```
src/app/
├── modules/     # Feature modules (e.g., paper)
├── plugins/     # Fastify plugins
├── routes/      # API route handlers
└── utils/       # Shared utilities
```

### Module Structure

Each module should contain:

-   Controller files (\*.controller.ts)
-   Route files (\*.route.ts)
-   Service files (\*.service.ts) if needed
-   Type definitions (\*.types.ts) if needed

### Best Practices

1. **Imports**: Use relative imports from `src/`
2. **Types**: Always use TypeScript types
3. **Async/Await**: Use async/await for asynchronous operations
4. **Error Handling**: Implement proper error handling with Fastify's error handling
5. **Logging**: Use Winston for logging (`src/app/utils/logger.ts`)

## Database Schema Management

### Schema Files Location

```
prisma/
├── schema.prisma      # Main schema file
└── schemas/           # Modular schema files
    ├── base.prisma
    ├── course.prisma
    ├── paper.prisma
    └── user.prisma
```

### After Schema Changes

Always run: `npx prisma generate`

## Environment Configuration

### Local Development

Use `.env` file with required variables

### Production/Staging

Environment managed through Doppler:

```bash
# Create local env file
pnpm run create-env-file:backend

# Create production env file
pnpm run create-env-file:backend:prod
```

## CI/CD Integration

### Nx Cloud

This workspace uses Nx Cloud for:

-   Remote caching
-   Distributed task execution
-   Build insights

### Running in CI

```bash
# Build only affected projects
nx affected:build --base=origin/master

# Test only affected projects
nx affected:test --base=origin/master

# Lint only affected projects
nx affected:lint --base=origin/master
```

## Troubleshooting

### Common Commands

```bash
# Clear Nx cache
nx reset

# Reinstall dependencies
pnpm install

# Regenerate Prisma client
npx prisma generate

# Check Nx installation
nx --version
```

### Cache Issues

If builds are failing unexpectedly:

1. Clear Nx cache: `nx reset`
2. Clear node_modules: `rm -rf node_modules && pnpm install`
3. Regenerate Prisma: `npx prisma generate`

## Migration Notes

This workspace was recently migrated from Nx 16.5.0 to 19.8.9 following the incremental migration path:

-   16.5.0 → 17.3.2 → 18.3.5 → 19.8.9
-   All `@nrwl/*` packages have been replaced with `@nx/*` packages
-   Package manager: pnpm (v10.8.0)

## Useful Links

-   [Nx Documentation](https://nx.dev)
-   [Nx Console](https://nx.dev/getting-started/editor-setup)
-   [Prisma Documentation](https://www.prisma.io/docs)
-   [Fastify Documentation](https://www.fastify.io)

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

-   When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e.
    `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
-   You have access to the Nx MCP server and its tools, use them to help the user
-   When answering questions about the repository, use the `nx_workspace` tool first to gain an understanding of the
    workspace architecture where applicable.
-   When working in individual projects, use the `nx_project_details` mcp tool to analyze and understand the specific
    project structure and dependencies
-   For questions around nx configuration, best practices or if you're unsure, use the `nx_docs` tool to get relevant,
    up-to-date docs. Always use this instead of assuming things about nx configuration
-   If the user needs help with an Nx configuration or project graph error, use the `nx_workspace` tool to get any
    errors

<!-- nx configuration end-->
