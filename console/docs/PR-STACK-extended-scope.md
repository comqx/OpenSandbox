# Extended-scope console PR stack (split guide)

This branch (`feat/console-extended-scope`) carries **MVP console + extended features** (PostgreSQL history, server lifecycle audit, Grafana, shell, image catalog, etc.). Upstream MVP is split separately on your fork (e.g. `feat/console-pr1-p0` … `feat/console-pr5-docs-ci`; local notes may live under gitignored `build/upstream-prs/`). Use this doc when carving **follow-on PRs** after MVP lands on `main`.

## Principles (for new work)

1. **One concern per commit** — BFF API, web UI, server, and docs should not share a commit unless the change is unusable without all pieces in one review (rare).
2. **Prefix matches blast radius** — `feat(console):`, `feat(server):`, `docs(console):`, `docs(superpowers):`. Avoid `feat(console,server):` unless you plan to `git split` before opening PRs.
3. **Schema before UI** — PG table / store helpers in one commit; routes + SPA in the next (or same PR as two commits).
4. **Tests with behavior** — put BFF/server tests in the same commit as the code they cover.
5. **No local/tooling noise** — do not commit `.agents/`, `.claude/skills`, or gitignored `build/` notes.

## Target PR order (cumulative on upstream MVP)

Stack branches so each PR is reviewable; later PRs rebase on the previous merge.

| PR | Suggested branch name | Scope | Depends on |
| --- | --- | --- | --- |
| **E0** | (upstream) | MVP console PR1–PR5 | `main` |
| **E1** | `feat/console-ext-history` | BFF history pool, reconcile, usage/history UI | E0 |
| **E2** | `feat/server-lifecycle-audit` | Server audit writer + config + tests only | `main` or E0 (no console requirement) |
| **E3** | `feat/console-ext-grafana-platform` | Mirror accel, Grafana monitor/proxy, platform settings | E1 |
| **E4** | `feat/console-sandbox-shell` | BFF shell + SPA + nginx WS; shell design spec | E0 |
| **E5** | `fix/server-k8s-batch-task-failure` | `batchsandbox_provider` task failure handling | `main` |
| **E6** | `feat/console-history-labels-create` | History labels/stats, sandbox create UX | E1 |
| **E7** | `feat/console-image-catalog` | Catalog API, list UI, YAML editor | E1 (PG catalog table) |
| **E8** | `feat/console-image-build` | Build context Phase 1+2 per [storage spec](../../docs/superpowers/specs/2026-10-13-console-sandbox-image-build-context-storage.md) | E7 |

E2 and E5 are **server-only** and can merge independently of console if maintainers prefer.

## Commit history (after restack)

Mixed commits were split on **2026-10-13** so each commit is **console-only** or **server-only** (see `console/scripts/restack-extended-scope-commits.sh`). Use `git log main..feat/console-extended-scope --oneline` for current SHAs; `split-extended-pr-stack.sh list` tracks cherry-pick groups for E1–E8.

| PR | Commits (subjects, in order) |
| --- | --- |
| **E0** | MVP console through `ba21ac13` (+ polish commits you fold into upstream PR1–5) |
| **E1** | `c0d40cbc` history UI … `6ba7e9ba` history poll reconcile |
| **E2** | `b40a7cfc` server audit writer, `9350e07f` audit metadata |
| **E3** | `477dbb94` mirror/Grafana/platform … `c9dfacaf` dependency accelerator label |
| **E4** | `12a562ed` shell … `771e1e83` lifecycle proxy dial |
| **E5** | `0837dcc6` BatchSandbox task failures |
| **E6** | `0a7d8a0b` labels + create UX |
| **E7** | `7c31dba1`, `d59776ec` image catalog + YAML editor |
| **E8** | `e82ec68a` build-context storage spec |

Docs/meta (optional separate PRs): `3db68ecb` English docs, `ee913ec9` / `e5877098` this stack guide.

### Re-running a restack

Only if you reintroduce mixed commits. Takes a backup branch, resets to `main`, replays and splits legacy SHAs:

```bash
./console/scripts/restack-extended-scope-commits.sh backup/console-extended-scope-before-restack-XXXXXXXX
```

Then refresh SHAs in `split-extended-pr-stack.sh`.

Use `./console/scripts/split-extended-pr-stack.sh branch e7 <base>` where `<base>` is **upstream MVP** (after E0 merges), not always `main`.

## Commit checklist (before push)

- [ ] Commit message prefix matches top-level dirs changed
- [ ] No unrelated file churn (lockfiles unless dependency change)
- [ ] Server changes have `server/tests/` when behavior changes
- [ ] BFF changes have `console/bff/tests/` when behavior changes
- [ ] User-visible behavior: `console/docs/` or `docs/guides/` updated in same PR

## Related specs

- Shell: [`docs/superpowers/specs/2026-10-09-console-sandbox-shell-design.md`](../../docs/superpowers/specs/2026-10-09-console-sandbox-shell-design.md)
- Image build storage: [`docs/superpowers/specs/2026-10-13-console-sandbox-image-build-context-storage.md`](../../docs/superpowers/specs/2026-10-13-console-sandbox-image-build-context-storage.md)
