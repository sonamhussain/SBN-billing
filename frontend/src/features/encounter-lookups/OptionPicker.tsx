import { useId, useState } from 'react'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'

export type PickerOption = { value: string; label: string }

// FE-03 — a native select over an organization's complete master list. When the list is long, a filter
// box narrows the options already loaded from the backend; it is not a server search and claims nothing
// beyond the list it was given. The current selection always stays visible. No UUID is ever typed.
const FILTER_THRESHOLD = 12

export function OptionPicker({
  label,
  hint,
  value,
  onChange,
  options,
  placeholder,
  loading,
  unavailable,
  required = false,
  disabled = false,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  options: readonly PickerOption[] | undefined
  // The first, empty option: "Select a clinician" for a required choice, "Not recorded" for an optional one.
  placeholder: string
  loading: boolean
  unavailable: boolean
  required?: boolean
  disabled?: boolean
}) {
  const selectId = useId()
  const [filter, setFilter] = useState('')
  const all = options ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle === '' ? all : all.filter((option) => option.value === value || option.label.toLowerCase().includes(needle))

  return (
    <div className="text-sm">
      <label htmlFor={selectId} className="font-medium text-slate-700">
        {label}
        {hint && <span className="ml-1 font-normal text-slate-500">{hint}</span>}
      </label>
      {unavailable ? (
        <p className="mt-1 text-red-700">{required ? 'Required setup options are unavailable.' : 'Options are unavailable.'}</p>
      ) : (
        <>
          {all.length > FILTER_THRESHOLD && (
            <Input
              className="mt-1"
              aria-label={`Filter ${label.toLowerCase()} options`}
              placeholder="Filter options"
              autoComplete="off"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <Select
            id={selectId}
            className="mt-1"
            required={required}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled || loading}
          >
            <option value="">{loading ? 'Loading...' : placeholder}</option>
            {shown.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {needle !== '' && (
            <p className="mt-1 text-xs text-slate-500">
              Showing {shown.length} of {all.length} loaded options
            </p>
          )}
        </>
      )}
    </div>
  )
}
