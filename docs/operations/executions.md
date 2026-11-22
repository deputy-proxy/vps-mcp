# Task execution operations

## Start a background command

Create and start a task sandbox first. Use the sandbox ID returned by sandbox.create/sandbox.start, not the worktree ID or raw Podman container ID.

Call sandbox.execution.start with a request such as:

    {
      "sandboxId": "134e5321-b4d7-4d4f-be92-ce56a984adaa",
      "command": ["npm", "test"],
      "cwd": "",
      "timeoutMs": 1800000
    }

- command is an argv array; it is not implicitly interpreted by a shell.
- cwd is optional and workspace-relative.
- timeoutMs defaults to 30 minutes and may be set up to 24 hours.
- No host environment is inherited. The runtime injects only an execution identity marker.
- The returned executionId is a new UUID. Persist it with the sandboxId. Only one background execution may run in a sandbox at a time; use another sandbox for independent concurrent work. The synchronous sandbox.exec tool is blocked until the background execution is terminal.

## Inspect status and logs

Use sandbox.execution.status with both IDs to reconcile one execution. Use sandbox.execution.list to inspect recent executions owned by a sandbox.

Use sandbox.execution.logs with both IDs:
- Without offset, it returns the latest bytes.
- With offset, it returns the next chunk and a nextOffset.
- maxBytes defaults to 64 KiB and is capped at 256 KiB.
- The response includes log size, continuation state and the execution-level truncation flag.

Logs are combined stdout/stderr, capped at 2 MiB per execution, and retained for seven days after completion. Execution metadata is retained for 30 days after completion. Logs are task output and must be treated as untrusted text.

## Cancel an execution

Call sandbox.execution.cancel with the owning sandboxId and executionId. The runtime validates the container-local process identity, sends SIGTERM to only that execution's process group, waits two seconds, then sends SIGKILL if it is still present.

If the runtime cannot prove that cancellation completed, the status remains unknown; do not assume that the command stopped. Stop the owning sandbox to terminate every process in that container. Stopping/removing one sandbox does not affect another sandbox or a persistent project service.

Commands that intentionally detach descendants into a separate session can escape process-group cancellation. They remain confined to the container; stopping or removing that sandbox terminates them.

## Restart recovery

Execution metadata and logs are stored under /var/lib/vps-sandbox, independently of the MCP process and its data directory. The task container owns the wrapper and timeout watchdog. Restarting the MCP server or runtime agent therefore does not by itself terminate a running task command.

After a restart:
1. Call sandbox.execution.status or sandbox.execution.list.
2. The runtime compares the persisted record with the selected container and its container-local process identity.
3. A live process remains running; a completed command is recovered from its exit marker; a stopped or missing container is reported as interrupted; an unverifiable identity is unknown.
4. Do not delete unknown records or infer success from a PID alone.

The log bind mount survives container stop/remove, so completed output remains available until retention expires.

## Limits and capacity errors

| Limit | Value |
|---|---:|
| Default / maximum timeout | 30 minutes / 24 hours |
| Per-execution log cap | 2 MiB |
| Per-sandbox log budget | 32 MiB |
| Global log budget | 512 MiB |
| Active executions per sandbox | 1 |
| Active executions globally | 8 |
| Log / metadata retention | 7 / 30 days |

Quota exhaustion returns an explicit SANDBOX_EXECUTION_QUOTA or SANDBOX_EXECUTION_LOG_QUOTA error. The runtime rejects new work rather than silently deleting retained logs.

## Runtime deployment

The rootless runtime agent imports executions.mjs from the same libexec directory. Deploy both files together with the reviewed installer:

    sudo bash scripts/install-vps-sandbox-runtime.sh

The installer preserves /etc/vps-sandbox/runtime.env, restarts only the sandbox runtime socket/service and does not change the public MCP service. Existing task containers created before the execution log mount was added must be recreated to use background execution.

For a live acceptance run, use a disposable worktree and an approved digest-pinned test image. Verify start/status/logs, non-zero exit codes, timeout, targeted cancellation, MCP restart recovery, stop/remove with an active command, log truncation, retention and quotas. Confirm no host process remains and project-service containers are unchanged.
