# Task workspace operations

## Create a workspace

Call `task-workspace.create` with the registered repository ID and a stable task identifier. Do not pass a task title as an identifier. The service generates a unique `task/<id>-<suffix>` branch from the fetched `origin/development` commit and records the base SHA and PR target.

Example:

`json
{
  "repositoryId": "deputy-proxy-cr8or-bfc053349a",
  "taskId": "issue-123",
  "retentionDays": 30
}
`

Omit `retentionDays` for manual retention. A time-based retention policy only makes the workspace eligible for later pruning; it never triggers automatic deletion.

## Inspect and review

- `task-workspace.list` optionally filters by repository or task ID.
- `task-workspace.inspect` returns metadata, worktree linkage, branch, base/head SHA and dirty state.
- `task-workspace.status` returns the lifecycle state and change counts.
- `task-workspace.diff` returns a diff summary and untracked and ignored file names, not file contents.

## Retain and resume

Use `task-workspace.retain` to preserve a worktree between sessions. This operation does not clean, reset or delete files. Use `task-workspace.resume` to mark an existing retained worktree active again. If the directory or Git worktree registration is missing, the service refuses to recreate it automatically.

## Remove and prune

Removal requires `confirm=true`. If tracked, staged, untracked or ignored changes exist, the operation refuses. To deliberately discard them, both `confirm=true` and `discardChanges=true` are required. Prefer retaining work until its diff has been reviewed or committed.

Pruning is dry-run by default:

`json
{
  "olderThanDays": 30,
  "dryRun": true
}
`

Actual pruning requires `dryRun=false` and `confirm=true`. Only retained, expired, clean workspaces whose metadata is older than the requested age are eligible. Dirty work, active workspaces, manual-retention workspaces, missing worktrees and unlinked directories are skipped.

## Recovery and troubleshooting

The registry is durable under `MCP_DATA_DIR/task-workspaces`. If the service stops during creation or removal, `task-workspace.inspect` or `task-workspace.status` reconciles the pending state with `git worktree list` and the filesystem. Do not manually delete a worktree directory or edit the registry while the service is running.

If a workspace is missing or unlinked, preserve the remaining directory and repository cache for investigation. Do not recreate it over existing files. Repository cache removal is blocked while Git reports linked worktrees.

Task workspaces are not containers. `sandboxId` only associates a workspace record with a future/independent sandbox lifecycle; it does not start or stop a sandbox.
