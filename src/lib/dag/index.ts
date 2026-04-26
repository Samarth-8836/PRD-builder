/**
 * Module 9 — Dependency Graph executor.
 *
 * Generic DAG runner. Knows nothing about the domain — just resolves the
 * topology, dispatches ready nodes with bounded concurrency, and reports
 * per-node status. Per-node exceptions are caught so independent branches
 * keep progressing. Callers must inspect the returned status map to detect
 * partial failure.
 *
 * Used by the Phase 2 stage runners (M4+) to orchestrate fan-out
 * operations like the workflow-detail batch.
 */

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface DAGNode<TResult = unknown> {
  id: string;
  deps?: string[];
  /** Optional predicate evaluated when all deps are settled. If it returns
   *  true, the node is marked `skipped` and not run. The argument is a
   *  read-only view of the dependency results so far. */
  skipIf?: (deps: ReadonlyMap<string, unknown>) => boolean;
  /** The work. Called once with a map of dep id -> dep result value. */
  run: (deps: ReadonlyMap<string, unknown>) => Promise<TResult>;
}

export interface NodeResult<TResult = unknown> {
  status: NodeStatus;
  value?: TResult;
  error?: Error;
  startedAt?: number;
  endedAt?: number;
  /** When status is `skipped` and the cause was a failed/skipped dep,
   *  this holds that dep's id. */
  blockedBy?: string;
}

export interface ExecuteOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (
    id: string,
    status: NodeStatus,
    info?: { error?: Error; blockedBy?: string }
  ) => void;
}

export async function executeDAG(
  nodes: DAGNode[],
  options: ExecuteOptions = {}
): Promise<Map<string, NodeResult>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const byId = new Map<string, DAGNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate DAG node id: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.deps ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Node ${node.id} declares unknown dep: ${dep}`);
      }
    }
  }

  const status = new Map<string, NodeResult>();
  for (const node of nodes) status.set(node.id, { status: "pending" });

  const inflight = new Set<string>();

  function isReady(node: DAGNode): boolean {
    if (status.get(node.id)!.status !== "pending") return false;
    for (const depId of node.deps ?? []) {
      const dep = status.get(depId)!;
      if (dep.status !== "completed" && dep.status !== "skipped") return false;
    }
    return true;
  }

  function findBlocker(node: DAGNode): string | undefined {
    for (const depId of node.deps ?? []) {
      const dep = status.get(depId)!;
      if (dep.status === "failed" || dep.status === "skipped") return depId;
    }
    return undefined;
  }

  function depResults(node: DAGNode): ReadonlyMap<string, unknown> {
    const out = new Map<string, unknown>();
    for (const depId of node.deps ?? []) {
      const dep = status.get(depId)!;
      if (dep.status === "completed") out.set(depId, dep.value);
    }
    return out;
  }

  async function runNode(node: DAGNode): Promise<void> {
    if (options.signal?.aborted) {
      transition(node.id, "failed", { error: new Error("Aborted") });
      return;
    }
    const startedAt = Date.now();
    transition(node.id, "running", undefined, startedAt);
    try {
      const value = await node.run(depResults(node));
      transition(
        node.id,
        "completed",
        { value },
        startedAt,
        Date.now()
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      transition(node.id, "failed", { error }, startedAt, Date.now());
    }
  }

  function transition(
    id: string,
    next: NodeStatus,
    extra?: { value?: unknown; error?: Error; blockedBy?: string },
    startedAt?: number,
    endedAt?: number
  ): void {
    const prev = status.get(id)!;
    const updated: NodeResult = {
      status: next,
      value: extra?.value ?? prev.value,
      error: extra?.error ?? prev.error,
      blockedBy: extra?.blockedBy ?? prev.blockedBy,
      startedAt: startedAt ?? prev.startedAt,
      endedAt: endedAt ?? prev.endedAt,
    };
    status.set(id, updated);
    options.onProgress?.(id, next, {
      error: updated.error,
      blockedBy: updated.blockedBy,
    });
  }

  return new Promise<Map<string, NodeResult>>((resolve) => {
    const tick = (): void => {
      if (allSettled()) {
        resolve(status);
        return;
      }

      // Skip nodes whose deps failed/skipped, OR whose skipIf says so.
      for (const node of nodes) {
        if (status.get(node.id)!.status !== "pending") continue;
        const blockedBy = findBlocker(node);
        if (blockedBy) {
          transition(node.id, "skipped", { blockedBy });
          continue;
        }
        if (isReady(node) && node.skipIf?.(depResults(node))) {
          transition(node.id, "skipped");
        }
      }

      // Dispatch ready nodes up to concurrency.
      while (inflight.size < concurrency) {
        const ready = nodes.find((n) => isReady(n) && !inflight.has(n.id));
        if (!ready) break;
        inflight.add(ready.id);
        // Fire-and-track. When done, drop from inflight and re-tick.
        runNode(ready)
          .catch(() => {
            /* runNode handles its own errors */
          })
          .finally(() => {
            inflight.delete(ready.id);
            tick();
          });
      }

      if (inflight.size === 0 && !allSettled()) {
        // Nothing in flight, nothing ready, but not done. Means stuck on
        // pending nodes whose deps haven't settled — shouldn't happen when
        // the DAG is well-formed and we mark blocked nodes as skipped.
        // Safety: mark stuck pending nodes as failed.
        for (const node of nodes) {
          if (status.get(node.id)!.status === "pending") {
            transition(node.id, "failed", {
              error: new Error("DAG deadlocked: node had no path to ready"),
            });
          }
        }
        resolve(status);
      }
    };

    function allSettled(): boolean {
      for (const r of status.values()) {
        if (r.status === "pending" || r.status === "running") return false;
      }
      return true;
    }

    tick();
  });
}

/** Convenience: throw if any node failed. */
export function assertAllCompleted(results: Map<string, NodeResult>): void {
  const failed: string[] = [];
  for (const [id, r] of results) {
    if (r.status === "failed") failed.push(`${id} (${r.error?.message ?? "unknown"})`);
  }
  if (failed.length > 0) {
    throw new Error(`DAG nodes failed: ${failed.join("; ")}`);
  }
}
