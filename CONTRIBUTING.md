# Contributing to LithoCMS

Thanks for your interest! This guide covers how work flows from a branch to a release.

## Branches

| Branch                                           | Purpose                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `main`                                           | Released code only. Every release is tagged here (`vX.Y.Z`).               |
| `dev`                                            | Integration branch and the default branch. All feature work targets `dev`. |
| `feat/<topic>`, `fix/<topic>`, `chore/<topic>` … | Short-lived work branches, created from `dev`.                             |

Flow:

1. Branch off `dev`: `git switch dev && git pull && git switch -c feat/short-topic`
2. Open a pull request into `dev`. It is **squash-merged**, so the PR title becomes the commit.
3. When a set of changes is ready to ship, a maintainer opens a PR from `dev` into `main` and
   merges it with a **merge commit** (not squash), so every Conventional Commit reaches `main`.
4. A release PR is then opened automatically on `main` (see [Releases](#releases)).

Never push directly to `main` or `dev`.

## Commit messages and PR titles

We use [Conventional Commits](https://www.conventionalcommits.org/). PR titles are checked in CI.

```
feat(theme-engine): add `image_url` filter
fix(mcp): reject tokens for another site
chore(deps): bump fastify
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
A breaking change uses `!` (`feat(api)!: …`) or a `BREAKING CHANGE:` footer.

One concern per PR. Keep PRs small enough to review in one sitting.

## Versioning

[Semantic Versioning](https://semver.org/), derived from the commits merged into `main`:

| Commits since last release | Bump (≥ 1.0.0) | Bump (0.x) |
| -------------------------- | -------------- | ---------- |
| `fix:`, `perf:`            | patch          | patch      |
| `feat:`                    | minor          | minor      |
| breaking change            | major          | minor      |

## Releases

Handled by [release-please](https://github.com/googleapis/release-please) on `main`:

1. After `dev` is merged into `main`, release-please opens (or updates) a release PR with the
   next version and the changelog.
2. Merging the release PR tags `vX.Y.Z` and creates the GitHub release.
3. The same workflow builds the multi-arch container image (`linux/amd64`, `linux/arm64`),
   pushes it to `ghcr.io/lithocms/lithocms:X.Y.Z` (and `X.Y`), attaches an SBOM and provenance,
   and signs it with cosign (keyless).

## Development setup

Requirements: Node.js 26 (current LTS), pnpm 12 (`npm i -g pnpm@12`), Docker.

```bash
pnpm dev              # postgres + server (hot reload) + caddy, all in Docker
```

Then open <http://site.localhost:8080> (a seeded dev site) and <http://admin.localhost:8080>.
Postgres is on `127.0.0.1:5432` (owner `lithocms_owner`/`owner`, runtime `lithocms_app`/`app`).
Reset everything with `docker compose -f compose.dev.yml down -v`.

On the host, for tests and tooling:

```bash
pnpm install
pnpm test             # unit + integration (Testcontainers, needs Docker)
pnpm lint && pnpm typecheck
pnpm db:generate      # migration from schema changes (packages/core/src/db/schema.ts)
```

## Pull request checklist

- [ ] Title follows Conventional Commits
- [ ] Tests added or updated (tenant-isolation tests for any tenant table or MCP tool)
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] New runtime dependency? One-line justification in the PR description
      (what it does, why we need it, maintenance status)
- [ ] User-facing strings go through i18n (`en` and `tr`)

## Security

Please do not open public issues for security problems. Use GitHub's private vulnerability
reporting on this repository instead.
