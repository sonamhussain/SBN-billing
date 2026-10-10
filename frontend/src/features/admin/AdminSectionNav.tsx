// FE-05 — the internal sub-navigation of an Administration area (Setup or Governance). It is page state,
// not routes or global navigation: only the chosen group renders, so only its records are loaded.
export function AdminSectionNav<K extends string>({
  label,
  groups,
  value,
  onChange,
}: {
  label: string
  groups: readonly { key: K; label: string }[]
  value: K
  onChange: (key: K) => void
}) {
  return (
    <nav aria-label={label} className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
      {groups.map((group) => {
        const active = group.key === value
        return (
          <button
            key={group.key}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? '-mb-px border-b-2 border-[var(--sbn-accent)] px-3 py-2 text-sm font-medium text-slate-950'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-slate-950'
            }
            onClick={() => onChange(group.key)}
          >
            {group.label}
          </button>
        )
      })}
    </nav>
  )
}
