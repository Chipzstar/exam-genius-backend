# Claude AI Agent Instructions for Nx Workspace

This document provides context for AI agents working with this Nx workspace.

## Workspace Overview

This is an Nx monorepo containing a Node.js backend application built with Fastify.

### Projects

-   **exam-genius-backend**: Main backend application (Node.js/Fastify/TypeScript)
-   **e2e**: End-to-end tests

### Technology Stack

-   **Build System**: Nx 19.8.9 with esbuild
-   **Runtime**: Node.js
-   **Framework**: Fastify
-   **Database**: Prisma ORM
-   **Language**: TypeScript 5.5.4
-   **Testing**: Jest
-   **Linting**: ESLint with TypeScript support
-   **Package Manager**: pnpm

## Nx Commands Reference

### Build & Serve

```bash
# Build the application
nx build exam-genius-backend

# Serve in development mode
nx serve exam-genius-backend

# Build for production
nx build exam-genius-backend --configuration=production
```

### Testing & Quality

```bash
# Run tests
nx test exam-genius-backend

# Run e2e tests
nx e2e e2e

# Run linting
nx lint exam-genius-backend
```

### Nx Utilities

```bash
# Show project graph
nx graph

# Show affected projects
nx affected:graph

# List all projects
nx show projects

# Show project details
nx show project exam-genius-backend
```

## Project Structure

```
exam-genius-backend/
├── src/
│   ├── app/
│   │   ├── modules/
│   │   │   └── paper/          # Paper module
│   │   ├── plugins/            # Fastify plugins
│   │   ├── routes/             # API routes
│   │   └── utils/              # Utilities (GPT, Logtail, Prisma)
│   ├── assets/                 # Static assets
│   └── main.ts                 # Application entry point
├── prisma/
│   ├── schema.prisma           # Main Prisma schema
│   └── schemas/                # Modular schema files
├── project.json                # Nx project configuration
├── tsconfig.json               # TypeScript configuration
└── jest.config.ts              # Jest configuration
```

## Key Configuration Files

### project.json

Defines Nx targets (build, serve, lint, test) and their configurations.

### nx.json

Workspace-level configuration including:

-   Task runner options (Nx Cloud)
-   Target defaults
-   Named inputs for caching
-   Default base branch for affected commands

### prisma/schema.prisma

Database schema using Prisma ORM with modular schema files.

## Development Workflow

1. **Making Changes**: Edit source files in `src/`
2. **Database Changes**:
    - Update schema in `prisma/schemas/`
    - Run `npx prisma generate` to regenerate client
3. **Testing**: Run `nx test exam-genius-backend`
4. **Building**: Run `nx build exam-genius-backend`
5. **Linting**: Run `nx lint exam-genius-backend`

## Nx Cloud Integration

This workspace is connected to Nx Cloud for:

-   Remote caching
-   Distributed task execution
-   CI/CD optimization

## Best Practices

1. **Use Nx Commands**: Always use `nx` commands instead of npm scripts when possible
2. **Leverage Caching**: Nx automatically caches task outputs for faster builds
3. **Check Affected**: Use `nx affected` commands in CI to only run tasks for changed projects
4. **Project Graph**: Use `nx graph` to understand project dependencies
5. **Prisma Client**: Always regenerate Prisma client after schema changes

## Common Issues & Solutions

### Build Fails

-   Ensure Prisma client is generated: `npx prisma generate`
-   Clear Nx cache: `nx reset`

### Type Errors

-   Check TypeScript version compatibility
-   Ensure all dependencies are installed: `pnpm install`

### Test Failures

-   Check if database is properly configured
-   Ensure environment variables are set

## Environment Variables

Environment variables are managed through:

-   Doppler for production/staging
-   `.env` file for local development

## Scripts Reference

```json
{
	"start": "nx serve --watch=false",
	"build": "npx prisma generate && nx build",
	"test": "nx test",
	"nx:serve:backend": "nx serve",
	"nx:build:backend": "nx build",
	"nx:build:backend:prod": "npx prisma generate && nx build --prod --skip-nx-cache"
}
```

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
