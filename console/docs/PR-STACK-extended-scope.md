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

## Mapping: current commits → intended PRs

Commits on `feat/console-extended-scope` (oldest first). **Clean** = single PR; **Mixed** = split or cherry-pick paths before upstream.

| Commit | Subject | PR bucket | Notes |
| --- | --- | --- | --- |
| `11705fbe` … `61419f7c` | MVP console base + fixes | **E0** (upstream stack) | Already split as PR1–PR5 on fork |
| `6978e0f4` | history persistence + usage UI | **E1** | Clean (console) |
| `e9b1a470` | semantic tags + log polish | **E0/E1** | UI-only; can ride MVP polish or E1 |
| `6a2440fe`, `6b33c25c` | history API fixes | **E1** | Clean |
| `347b4b52` | gitignore pnpm locks | **E0** | Chore |
| `fce58f3f` | PG audit + shared history | **E1 + E2** | **Mixed** — split `server/` vs `console/` |
| `739496c3` | mirror accel, Grafana, platform | **E3** | Large; OK as one PR, multiple commits ideal |
| `9e6496fb` | English console docs | **E0** docs PR or E3 | Docs-only |
| `164062c9` | Grafana/platform polish | **E3** | Clean |
| `752a35c6` | shell + K8s batch fix | **E4 + E5** | **Mixed** — split server test/provider vs console |
| `869477c9`, `a559b56d` | shell nginx + proxy dial | **E4** | Clean |
| `15711f34` | history reconcile fix | **E1** | Clean |
| `5e8eb375` | Grafana proxy + history poll | **E3 + E1** | Cross-cutting; acceptable as E3 if E1 merged |
| `1aa6ce07` | labels, create UX, audit metadata | **E6 + E2** | **Mixed** — split server metadata vs console |
| `095a7e84`, `5cb1527e` | image catalog + YAML editor | **E7** | Clean (console) |
| `19e2ed58` | image build OSS/PG spec | **E8** | Docs-only (implementation follows) |
| `87884f79` | dependency accelerator nav label | **E3** | UI copy only |
| `1a042506` | this split guide + script | — | Meta; not a product PR |

### Fixing mixed commits (before opening PRs)

Option A — **soft reset + recommit** (branch not shared):

```bash
git rebase -i <merge-base-with-main>
# mark mixed commit as "edit", then:
git reset HEAD~1
git add server/ && git commit -m "feat(server): ..."
git add console/ && git commit -m "feat(console): ..."
git rebase --continue
```

Option B — **cherry-pick onto fresh branch** (safer if branch is pushed):

```bash
git checkout -b feat/server-lifecycle-audit main
git cherry-pick fce58f3f
# resolve: only stage server/ hunk, commit; then cherry-pick console hunks separately
```

Use `console/scripts/split-extended-pr-stack.sh list` to print cherry-pick groups.

## Commit checklist (before push)

- [ ] Commit message prefix matches top-level dirs changed
- [ ] No unrelated file churn (lockfiles unless dependency change)
- [ ] Server changes have `server/tests/` when behavior changes
- [ ] BFF changes have `console/bff/tests/` when behavior changes
- [ ] User-visible behavior: `console/docs/` or `docs/guides/` updated in same PR

## Related specs

- Shell: [`docs/superpowers/specs/2026-10-09-console-sandbox-shell-design.md`](../../docs/superpowers/specs/2026-10-09-console-sandbox-shell-design.md)
- Image build storage: [`docs/superpowers/specs/2026-10-13-console-sandbox-image-build-context-storage.md`](../../docs/superpowers/specs/2026-10-13-console-sandbox-image-build-context-storage.md)
