// Audit F08 — deterministic concurrency barriers for guarded writers. A writer calls
// `concurrencyProbe(name)` at the point where a competing writer must be able to interleave
// (immediately after its locked read). In the running application no handler is ever registered,
// so the call is a no-op. A test registers a one-shot handler to pause exactly one writer at that
// point, then lets a competing writer run, which proves the interleaving instead of relying on
// sleeps. Handlers are one-shot so the competing writer passes through without pausing.

type ProbeHandler = () => Promise<void>

const handlers = new Map<string, ProbeHandler>()

export function setConcurrencyProbe(name: string, handler: ProbeHandler): void {
  handlers.set(name, handler)
}

export function clearConcurrencyProbes(): void {
  handlers.clear()
}

export async function concurrencyProbe(name: string): Promise<void> {
  const handler = handlers.get(name)
  if (!handler) return
  handlers.delete(name)
  await handler()
}
