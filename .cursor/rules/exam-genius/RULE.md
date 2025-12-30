# Nx Monorepo Configuration

This is an Nx workspace. When working with this codebase:

## Project Structure
- This is a Node.js backend application using Fastify
- Built with TypeScript and esbuild
- Uses Prisma for database management
- Nx version: 19.8.9

## Common Commands
- `nx build exam-genius-backend` - Build the application
- `nx serve exam-genius-backend` - Run the dev server
- `nx test exam-genius-backend` - Run tests
- `nx lint exam-genius-backend` - Run linting
- `npx prisma generate` - Generate Prisma client
- `nx graph` - View the project dependency graph

## Architecture
- Main application: exam-genius-backend
- E2E tests: e2e project
- Uses Nx Cloud for caching and CI optimization

## Key Files
- `project.json` - Project configuration with build targets
- `nx.json` - Nx workspace configuration
- `prisma/schema.prisma` - Database schema
- `src/main.ts` - Application entry point

## Best Practices
- Always run `npx prisma generate` after schema changes
- Use Nx caching for faster builds
- Follow the existing project structure when adding new features
- Use TypeScript for all source files

