import { createHash, randomUUID } from 'node:crypto';

export const EXECUTION_POLICY = Object.freeze({
  defaultTimeoutMs: 30 * 60 * 1000,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  maxLogBytes: 2 * 1024 * 1024,
  maxLogBytesPerSandbox: 32 * 1024 * 1024,
  maxLogBytesGlobal: 512 * 1024 * 1024,
  maxActivePerSandbox: 1,
  maxActiveGlobal: 8,
  logRetentionMs: 7 * 24 * 60 * 60 * 1000,
  recordRetentionMs: 30 * 24 * 60 * 60 * 1000,
  cancellationGraceMs: 2000,
});

export function executionRetentionActions(record, now = Date.now()) {
  if (['starting', 'running', 'cancelling', 'unknown'].includes(record.status)) {
    return { expireLogs: false, deleteRecord: false };
  }
  return {
    expireLogs: Number.isFinite(Date.parse(record.logsExpireAt)) && Date.parse(record.logsExpireAt) <= now,
    deleteRecord: Number.isFinite(Date.parse(record.recordExpireAt)) && Date.parse(record.recordExpireAt) <= now,
  };
}

export function assertExecutionLogQuota({ globalBytes, sandboxBytes, reserveBytes = EXECUTION_POLICY.maxLogBytes }) {
  if (!Number.isSafeInteger(globalBytes) || globalBytes < 0 || !Number.isSafeInteger(sandboxBytes) || sandboxBytes < 0 ||
      !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new Error('Invalid execution log quota usage');
  if (globalBytes + reserveBytes > EXECUTION_POLICY.maxLogBytesGlobal) throw new Error('SANDBOX_EXECUTION_LOG_QUOTA: global execution log budget reached');
  if (sandboxBytes + reserveBytes > EXECUTION_POLICY.maxLogBytesPerSandbox) throw new Error('SANDBOX_EXECUTION_LOG_QUOTA: sandbox execution log budget reached');
  return true;
}

export function executionLogReadWindow(sizeBytes, offset, maxBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid execution log read window');
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('Invalid execution log offset');
  const start = offset === undefined ? Math.max(0, sizeBytes - maxBytes) : Math.min(offset, sizeBytes);
  const length = Math.min(maxBytes, Math.max(0, sizeBytes - start));
  return { offset: start, length, nextOffset: start + length, hasMore: start + length < sizeBytes };
}

export function safeExecutionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid execution ID');
  }
  return value.toLowerCase();
}

export function executionCommandMetadata(command) {
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 ||
      command.some((arg) => typeof arg !== 'string' || arg.length < 1 || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('Command must be a non-empty argument array of bounded strings');
  }
  const executable = String(command[0])
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .slice(0, 128);
  return {
    executable,
    argumentCount: command.length,
    fingerprint: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
  };
}

export function buildExecutionRunnerScript() {
  return String.raw`set -eu
umask 077
id=$1
cwd=$2
timeout_seconds=$3
max_log_bytes=$4
shift 4
root=/workspace
exec_root=/run/vps-mcp-executions
case "$cwd" in '' ) ;; /*|*\\*) echo 'Invalid workspace path' >&2; exit 126;; * ) case "/$cwd/" in */../*|*/./*) echo 'Invalid workspace path' >&2; exit 126;; esac;; esac
if [ -n "$cwd" ]; then cd "$root/$cwd"; else cd "$root"; fi
resolved=$(pwd -P)
case "$resolved" in "$root"|"$root"/*) ;; *) echo 'Working directory escapes the workspace' >&2; exit 126;; esac
log="$exec_root/$id.log"
fifo="$exec_root/$id.fifo"
cancel_fifo="$exec_root/$id.cancel"
identity="$exec_root/$id.identity"
status="$exec_root/$id.status"
reason="$exec_root/$id.reason"
[ ! -e "$log" ] && [ ! -e "$fifo" ] && [ ! -e "$cancel_fifo" ] && [ ! -e "$identity" ] && [ ! -e "$status" ] || { echo 'Execution ID already exists' >&2; exit 125; }
mkfifo "$fifo" "$cancel_fifo"
exec 4<>"$cancel_fifo"
(ulimit -f "$(((max_log_bytes + 1 + 511) / 512))"; { head -c "$((max_log_bytes + 1))"; cat >/dev/null; } < "$fifo" > "$log") &
reader=$!
VPS_MCP_EXECUTION_ID="$id" setsid sh -c '
  set -eu
  id=$1
  identity=$2
  status=$3
  fifo=$4
  shift 4
  pid=$$
  stat_line=$(sed "s/^.*) //" "/proc/$pid/stat")
  start_time=$(printf "%s\n" "$stat_line" | awk "{print \$20}")
  process_group=$(printf "%s\n" "$stat_line" | awk "{print \$3}")
  [ -n "$start_time" ] && [ "$process_group" = "$pid" ] || exit 125
  printf "%s %s %s\n" "$pid" "$process_group" "$start_time" > "$identity.tmp"
  mv "$identity.tmp" "$identity"
  set +e
  "$@" > "$fifo" 2>&1
  exit_code=$?
  set -e
  printf "%s\n" "$exit_code" > "$status.tmp"
  mv "$status.tmp" "$status"
  exit "$exit_code"
' -- "$id" "$identity" "$status" "$fifo" "$@" &
runner_pid=$!
deadline=$(( $(date +%s) + 3 ))
while [ ! -s "$identity" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.05; done
if [ -s "$identity" ] && [ "$timeout_seconds" -gt 0 ]; then
  setsid sh -c '
    id=$1
    pid=$2
    process_group=$3
    start_time=$4
    timeout_seconds=$5
    reason=$6
    cancel_fifo=$7
    exec 3<>"$cancel_fifo"
    if read -r -t "$timeout_seconds" cancel_signal <&3; then exit 0; fi
    alive=0
    if [ -r "/proc/$pid/stat" ]; then
      stat_line=$(sed "s/^.*) //" "/proc/$pid/stat" 2>/dev/null || true)
      current_start=$(printf "%s\n" "$stat_line" | awk "{print \$20}")
      current_group=$(printf "%s\n" "$stat_line" | awk "{print \$3}")
      if [ "$current_start" = "$start_time" ] && [ "$current_group" = "$process_group" ] &&
         tr "\0" "\n" < "/proc/$pid/environ" 2>/dev/null | grep -Fx "VPS_MCP_EXECUTION_ID=$id" >/dev/null; then alive=1; fi
    elif kill -0 -"$process_group" 2>/dev/null; then
      alive=1
    fi
    if [ "$alive" -eq 1 ]; then
      printf "timeout\n" > "$reason.tmp"
      mv "$reason.tmp" "$reason"
      kill -TERM -"$process_group" 2>/dev/null || true
      sleep 2
      if kill -0 -"$process_group" 2>/dev/null; then kill -KILL -"$process_group" 2>/dev/null || true; fi
    fi
  ' -- "$id" "$(awk '{print $1}' "$identity")" "$(awk '{print $2}' "$identity")" "$(awk '{print $3}' "$identity")" "$timeout_seconds" "$reason" "$cancel_fifo" &
  watchdog_pid=$!
else
  watchdog_pid=
fi
set +e
wait "$runner_pid"
runner_code=$?
set -e
printf 'done\n' >&4 2>/dev/null || true
exec 4>&-
if [ -n "$watchdog_pid" ]; then wait "$watchdog_pid" 2>/dev/null || true; fi
if [ -s "$identity" ]; then
  process_group=$(awk '{print $2}' "$identity")
  kill -TERM -"$process_group" 2>/dev/null || true
  sleep 0.05
  kill -KILL -"$process_group" 2>/dev/null || true
fi
wait "$reader" 2>/dev/null || true
rm -f "$fifo" "$cancel_fifo"
exit 0
`;
}

export function buildExecutionStartArgs({ runtimeId, executionId, cwd = '', timeoutMs, maxLogBytes = EXECUTION_POLICY.maxLogBytes, command }) {
  const id = safeExecutionId(executionId);
  if (typeof runtimeId !== 'string' || !/^[a-f0-9]{12,64}$/i.test(runtimeId)) throw new Error('Invalid runtime container ID');
  if (typeof cwd !== 'string' || cwd.length > 4096 || cwd.startsWith('/') || cwd.includes('\\') || cwd.split('/').some((part) => !part || part === '..' || part === '.')) {
    if (cwd !== '') throw new Error('Working directory must be workspace-relative');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > EXECUTION_POLICY.maxTimeoutMs) throw new Error('timeoutMs is outside the allowed range');
  if (!Number.isInteger(maxLogBytes) || maxLogBytes < 1024 || maxLogBytes > EXECUTION_POLICY.maxLogBytes) throw new Error('maxLogBytes is outside the allowed range');
  executionCommandMetadata(command);
  return [
    'exec', '--detach', runtimeId, 'setsid', 'sh', '-c', buildExecutionRunnerScript(), '--',
    id, cwd, String(Math.ceil(timeoutMs / 1000)), String(maxLogBytes), ...command,
  ];
}

export function buildExecutionIdentityCheckScript() {
  return String.raw`set -eu
id=$1
pid=$2
expected_group=$3
expected_start=$4
if [ -r "/proc/$pid/stat" ]; then
  stat_line=$(sed 's/^.*) //' "/proc/$pid/stat")
  start_time=$(printf '%s\n' "$stat_line" | awk '{print $20}')
  process_group=$(printf '%s\n' "$stat_line" | awk '{print $3}')
  if [ "$start_time" = "$expected_start" ] && [ "$process_group" = "$expected_group" ] &&
     tr '\0' '\n' < "/proc/$pid/environ" | grep -Fx "VPS_MCP_EXECUTION_ID=$id" >/dev/null; then exit 0; fi
fi
kill -0 -"$expected_group" 2>/dev/null
`;
}

export function buildExecutionCancelScript() {
  return String.raw`set -eu
id=$1
reason=$2
pid=$3
process_group=$4
start_time=$5
reason_file="/run/vps-mcp-executions/$id.reason"
[ "$pid" -gt 1 ] && [ "$process_group" = "$pid" ] || exit 4
alive=0
if [ -r "/proc/$pid/stat" ]; then
  stat_line=$(sed 's/^.*) //' "/proc/$pid/stat")
  current_start=$(printf '%s\n' "$stat_line" | awk '{print $20}')
  current_group=$(printf '%s\n' "$stat_line" | awk '{print $3}')
  if [ "$current_start" = "$start_time" ] && [ "$current_group" = "$process_group" ] &&
     tr '\0' '\n' < "/proc/$pid/environ" | grep -Fx "VPS_MCP_EXECUTION_ID=$id" >/dev/null; then alive=1; fi
elif kill -0 -"$process_group" 2>/dev/null; then
  alive=1
fi
if [ "$alive" -eq 1 ]; then
  [ -e "$reason_file" ] || { printf '%s\n' "$reason" > "$reason_file.tmp"; mv "$reason_file.tmp" "$reason_file"; }
  kill -TERM -"$process_group" 2>/dev/null || true
  sleep 2
  if kill -0 -"$process_group" 2>/dev/null; then kill -KILL -"$process_group" 2>/dev/null || true; fi
  exit 0
fi
exit 2
`;
}

export function createExecutionRecord({ sandboxId, runtimeId, command, cwd, timeoutMs, now = new Date() }) {
  const id = randomUUID();
  return {
    id,
    sandboxId,
    command: executionCommandMetadata(command),
    cwd,
    runtimeIdentity: { runtimeId, containerPid: null, processGroupId: null, processStartTime: null, marker: id },
    status: 'starting',
    exitCode: null,
    timeoutMs,
    timeoutAt: timeoutMs > 0 ? new Date(now.getTime() + timeoutMs).toISOString() : null,
    cancelReason: null,
    logFile: id + '.log',
    logBytes: 0,
    logTruncated: false,
    createdAt: now.toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: now.toISOString(),
    logsExpireAt: new Date(now.getTime() + EXECUTION_POLICY.logRetentionMs).toISOString(),
    recordExpireAt: new Date(now.getTime() + EXECUTION_POLICY.recordRetentionMs).toISOString(),
  };
}
