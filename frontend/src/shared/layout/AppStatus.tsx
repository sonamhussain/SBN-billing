export function AppStatus({ label }: { label: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--sbn-bg)]">
      <p className="text-sm text-slate-600">{label}</p>
    </main>
  )
}
