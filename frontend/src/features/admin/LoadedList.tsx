import { useState, type ReactNode } from 'react'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'

// FE-05 — a compact list over a collection the backend returned in full. The filter narrows only the rows
// already loaded (it is not a server search), and long lists render in pages of 50 so a master with
// thousands of rows stays usable. It never invents, merges or reorders records.

const PAGE_SIZE = 50

export type LoadedListQuery<T> = { data: T[] | undefined; isPending: boolean; isError: boolean; permitted: boolean }

export function LoadedList<T>({
  noun,
  query,
  filterText,
  rowKey,
  renderRow,
  emptyTitle,
}: {
  // Plural noun used in counts and messages, e.g. "clinicians".
  noun: string
  query: LoadedListQuery<T>
  filterText: (item: T) => string
  rowKey: (item: T) => string
  renderRow: (item: T) => ReactNode
  emptyTitle: string
}) {
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)

  if (!query.permitted) return <EmptyState title={`${capitalize(noun)} are not available to you.`} />
  if (query.isPending) return <Skeleton className="h-24 w-full" />
  if (query.isError && !query.data) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {capitalize(noun)} could not be loaded.
      </p>
    )
  }

  const all = query.data ?? []
  if (all.length === 0) return <EmptyState title={emptyTitle} />

  const needle = filter.trim().toLowerCase()
  const matches = needle === '' ? all : all.filter((item) => filterText(item).toLowerCase().includes(needle))
  const shown = matches.slice(0, limit)

  return (
    <div className="space-y-2">
      <Input
        aria-label={`Filter loaded ${noun}`}
        placeholder={`Filter loaded ${noun}`}
        autoComplete="off"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setLimit(PAGE_SIZE)
        }}
      />
      <p className="text-xs text-slate-500">
        Showing {shown.length} of {needle === '' ? `${all.length} loaded ${noun}` : `${matches.length} matching (${all.length} loaded)`}
      </p>
      {matches.length === 0 ? (
        <p className="text-sm text-slate-500">No loaded {noun} match the filter.</p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {shown.map((item) => (
            <li key={rowKey(item)}>{renderRow(item)}</li>
          ))}
        </ul>
      )}
      {matches.length > shown.length && (
        <Button type="button" className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" onClick={() => setLimit(limit + PAGE_SIZE)}>
          Show {Math.min(PAGE_SIZE, matches.length - shown.length)} more
        </Button>
      )}
    </div>
  )
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
