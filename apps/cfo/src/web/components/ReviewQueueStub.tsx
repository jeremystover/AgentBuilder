// Phase 1 stub. Live review queue (with drawer + confirm/override/split)
// lands in Phase 2 alongside the real chat tools.

export function ReviewQueueStub() {
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          Review queue
        </h2>
      </div>
      <div className="flex-1 px-4 py-6 text-xs text-text-subtle">
        <p>The review queue will live here.</p>
        <p className="mt-2">Coming in Phase 2 — see <code className="font-mono">handleListReview</code>.</p>
      </div>
    </div>
  );
}
