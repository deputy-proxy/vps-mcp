import fs from "node:fs/promises";
import path from "node:path";

export type WorkspaceDiskMeasurement = {
  bytes: number | null;
  status: "available" | "partial" | "unavailable";
};

type ScanState = {
  pending: Array<{ directory: string; resumeAfter?: string }>;
  bytes: number;
  completedAt: number | null;
};

export type WorkspaceDiskScannerOptions = {
  maxEntriesPerBatch?: number;
  maxDurationMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_ENTRIES_PER_BATCH = 20_000;
const DEFAULT_MAX_DURATION_MS = 2_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Incrementally measures workspace disk usage. Each call is bounded, and
 * unfinished directory traversal is retained in memory for the next call.
 */
export class WorkspaceDiskScanner {
  private readonly states = new Map<string, ScanState>();
  private readonly maxEntriesPerBatch: number;
  private readonly maxDurationMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  constructor(options: WorkspaceDiskScannerOptions = {}) {
    this.maxEntriesPerBatch = options.maxEntriesPerBatch ?? DEFAULT_MAX_ENTRIES_PER_BATCH;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async measure(directory: string): Promise<WorkspaceDiskMeasurement> {
    const target = path.resolve(directory);
    let state = this.states.get(target);

    if (state?.completedAt !== null && state?.completedAt !== undefined
      && this.now() - state.completedAt < this.cacheTtlMs) {
      return { bytes: state.bytes, status: "available" };
    }

    if (!state || state.completedAt !== null) {
      state = { pending: [{ directory: target }], bytes: 0, completedAt: null };
      this.states.set(target, state);
    }

    const startedAt = this.now();
    let entriesScanned = 0;

    try {
      while (state.pending.length > 0) {
        if (entriesScanned >= this.maxEntriesPerBatch || this.now() - startedAt >= this.maxDurationMs) {
          return { bytes: state.bytes, status: "partial" };
        }

        const task = state.pending.pop()!;
        const current = task.directory;
        const directoryStat = await fs.lstat(current);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;

        const handle = await fs.opendir(current);
        let resumeMarkerFound = task.resumeAfter === undefined;
        let lastProcessedName: string | undefined;
        for await (const child of handle) {
          if (!resumeMarkerFound) {
            if (child.name === task.resumeAfter) resumeMarkerFound = true;
            continue;
          }
          if (entriesScanned >= this.maxEntriesPerBatch || this.now() - startedAt >= this.maxDurationMs) {
            state.pending.push(lastProcessedName === undefined ? { directory: current } : { directory: current, resumeAfter: lastProcessedName });
            return { bytes: state.bytes, status: "partial" };
          }
          entriesScanned += 1;

          if (child.isSymbolicLink()) { lastProcessedName = child.name; continue; }
          const item = path.join(current, child.name);
          if (child.isDirectory()) {
            const stat = await fs.lstat(item);
            if (stat.isDirectory() && !stat.isSymbolicLink()) state.pending.push({ directory: item });
          } else if (child.isFile()) {
            const stat = await fs.lstat(item);
            if (stat.isFile() && !stat.isSymbolicLink() && Number.isSafeInteger(stat.size) && stat.size >= 0) {
              state.bytes += stat.size;
            }
            if (!Number.isSafeInteger(state.bytes)) {
              this.states.delete(target);
              return { bytes: null, status: "unavailable" };
            }
          }
          lastProcessedName = child.name;
        }
        if (!resumeMarkerFound) {
          state.pending = [{ directory: target }];
          state.bytes = 0;
          return { bytes: 0, status: "partial" };
        }
      }

      state.completedAt = this.now();
      return { bytes: state.bytes, status: "available" };
    } catch {
      this.states.delete(target);
      return { bytes: null, status: "unavailable" };
    }
  }

  forget(directory: string): void {
    this.states.delete(path.resolve(directory));
  }

  retainOnly(directories: Iterable<string>): void {
    const retained = new Set([...directories].map((directory) => path.resolve(directory)));
    for (const directory of this.states.keys()) {
      if (!retained.has(directory)) this.states.delete(directory);
    }
  }

  clear(): void {
    this.states.clear();
  }
}
