# Repository Guidelines

## Project Structure & Module Organization

The root TypeScript service is the provider-neutral communications gateway. `src/core` owns sessions and shared types; adapters live under `src/adapters`; HTTP, MCP, persistence, media, and webhook boundaries have their own `src` subdirectories. Root tests exercise this layer. `integrations/textbee` is the vendored self-hosted messaging plane: NestJS API, Next.js dashboard, and Android Gradle application. Docker Desktop development is defined by `docker-compose.dev.yml`; the real self-hosted TextBee profile is `docker-compose.textbee.yml`. Asterisk and edge deployment configuration lives under `docker` and `deploy`.

## Build, Test, and Development Commands

- `npm ci && npm run build && npm test`: install, compile, and test the gateway.
- `npm run typecheck`: check gateway TypeScript without emitting files.
- `cd integrations/textbee/api && pnpm install --frozen-lockfile && pnpm test`: test the NestJS API. Pass a test path after `--`, for example `pnpm test -- billing/default-plan.service.spec.ts`.
- `cd integrations/textbee/web && pnpm install --frozen-lockfile && pnpm test`: run dashboard Vitest tests; append a file path for one test.
- `cd integrations/textbee/android && ./gradlew assembleDevDebug`: build the self-hosted Android development APK.
- `docker compose -f docker-compose.textbee.yml up -d --build`: rebuild the TextBee service plane; `TEXTBEE_FIREBASE_ADMIN_JSON` must identify the local credential file.

## Coding Style & Naming Conventions

The gateway uses strict TypeScript and ESM. TextBee API formatting is enforced by Prettier and ESLint; the web application uses ESLint and TypeScript. Preserve existing domain names and NestJS module/service/controller patterns. Never commit Firebase credentials, OAuth secrets, APK signing keys, `.env` files, or generated build directories.

## Testing Guidelines

Root tests use Node's test runner through `tsx`; API tests use Jest; web unit tests use Vitest and Testing Library, with Playwright for browser flows. Add regression coverage beside the affected module.

## Commit & Pull Request Guidelines

This repository starts with no local history. Use concise imperative subjects such as `Fix self-hosted billing defaults`. Pull requests should state the affected plane, validation commands, configuration changes, and any hardware validation still required.

