---
title: Fork sync workflow (solo rebase)
description: Keep main/base aligned with upstream and maintain custom patches on a linear custom branch.
---

# Fork sync workflow (solo rebase)

This guide applies to the **comqx fork** workflow: one maintainer, rebase-only on `custom`.

## Remotes and branches

| Name | Remote | Role |
|------|--------|------|
| `upstream` | `opensandbox-group/OpenSandbox` | Read-only official tree |
| `origin` | Your fork | Where you push |
| `main` | `origin` | Pure upstream mirror (same as `base` if present) |
| `custom` | `origin` | All fork-specific changes; **only this branch gets force-with-lease pushes after rebase** |

Legacy feature branches (`feat/console-extended-scope`, etc.) are archived after migration; develop on `custom` or short-lived `feature/*` branches rebased into `custom`.

## One-time backup

```bash
git tag backup_old_dev_before_migrate <old-tip>
git push origin backup_old_dev_before_migrate
```

## Regular upstream sync

From repo root:

```bash
chmod +x scripts/sync-upstream-solo.sh
./scripts/sync-upstream-solo.sh
```

Manual equivalent:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout custom && git rebase main
# resolve conflicts, test
git push --force-with-lease origin custom
```

## Daily feature work

```bash
git checkout custom
git pull --rebase origin custom   # if you use another machine
git checkout -b feature/my-change
# commit ...
git checkout custom
git rebase feature/my-change
git push --force-with-lease origin custom
git branch -d feature/my-change
```

## Upstream PRs

```bash
git checkout main
git checkout -b pr/my-fix
git cherry-pick <commit-from-custom>
git push origin pr/my-fix
```

Use `console/scripts/split-extended-pr-stack.sh` with `main` as the base ref when splitting console PR groups.

## Rollback

```bash
git checkout custom
git reset --hard <last-good-commit>
git push --force-with-lease origin custom
```

During a failed sync: `git rebase --abort`.
