# Task workspaces and Git worktrees

## Purpose and boundaries

A task workspace is a durable, isolated Git worktree backed by a registered repository's persistent bare cache. Every task gets a separate directory and a generated feature branch. Two tasks in the same repository never share a mutable checkout.

Task workspaces are independent of container lifecycle. `sandboxId` is optional correlation metadata only; creating, retaining, resuming or removing a workspace does not create, stop or remove a container. Sandbox-scoped file and command execution is a separate capability.

## Branch and path model

- The only supported task base is `development`, resolved from the most recently fetched `refs/remotes/origin/development` commit.
- The base commit SHA is recorded before worktree creation and used as the exact worktree starting point.
- The target pull-request branch is always `development`.
- Branch names are generated as `task/<safe-task-id>-<8-character-workspace-suffix>`. Task titles are never used in branch or filesystem paths.
- `validateTaskBranchCreation` is called immediately before `git worktree add -b`. Protected branch names and invalid Git refs are rejected.
- Alternate bases for maintenance/release work are intentionally not accepted by this interface. They require a separately documented policy and validator.
- Worktrees are stored at `MCP_DATA_DIR/task-workspaces/worktrees/<repository-id>/<workspace-uuid>`; metadata is stored in `MCP_DATA_DIR/task-workspaces/registry.json`.

The registry uses schema version 1, atomic replacement and a process lock. Metadata files and directories are created with owner-only permissions. Repository-level locks are shared with repository fetch/removal so those operations cannot race task-worktree mutations.

## Lifecycle

States: `creating`, `active`, `retained`, `removing`, `removed`, `failed`.

- `create`: fetch the registered repository cache, resolve `origin/development`, persist a `creating` record, create a new branch/worktree, then mark it `active`.
- `retain`: mark an existing worktree `retained`; do not remove it or modify its files.
- `resume`: mark an existing retained worktree `active`. Missing or unlinked worktrees are not recreated automatically.
- `remove`: require `confirm=true`. Modified, staged, untracked or ignored work blocks removal unless `discardChanges=true` is also explicitly supplied with confirmation.
- `prune`: considers only retained workspaces with an expired time-based retention policy that are clean and older than the requested age. Dry-run is the default; actual pruning requires `dryRun=false` and `confirm=true`.
- `inspect` and `status`: reconcile interrupted `creating`/`removing` transitions against Git's worktree registry and the filesystem. A partially completed operation is reported honestly; missing work is not silently recreated.

The default retention policy is manual. `retentionDays` sets an expiry but does not schedule deletion. Pruning is an explicit operator action.

## Safety and credentials

- Worktree paths are derived from trusted repository/workspace IDs and checked against the managed root. Symlinks and path escapes are rejected.
- Every workspace operation verifies that the registered worktree is attached to the expected task branch. `main` and `development` are never task branches.
- No MCP task-workspace operation exposes checkout, commit or push to protected branches. Future sandbox execution must remain scoped to the registered worktree and enforce this invariant.
- Git runs with system/global Git configuration disabled, inherited `GIT_*` variables removed, and SSH agent environment variables removed. HTTPS credential handoff is only through the explicitly configured trusted credential helper; host SSH agents and credential stores are not mounted into a workspace.
- The task-workspace registry stores no credentials.
- Repository removal already refuses while Git worktrees are linked, so retained workspaces protect their parent cache from deletion.

## MCP tools

`task-workspace.create`, `list`, `inspect`, `status`, `diff`, `retain`, `resume`, `remove` and `prune` provide the lifecycle. Schemas, destructive confirmations and output semantics are defined in `src/tools.ts` and covered by contract/integration tests.
