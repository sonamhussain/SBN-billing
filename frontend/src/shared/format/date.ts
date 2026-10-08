// FE-02 — a calendar date (YYYY-MM-DD) is shown as a calendar date, never shifted by the browser time
// zone. Anything that is not a date string is shown as received rather than guessed.
export function formatDateOnly(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  )
}

// FE-04 — an instant (ISO-8601 timestamp such as respondedAt or evaluatedAt) in the viewer's local time.
// Unlike a calendar date it is a moment, so local display is correct. Unparseable input is shown as received.
const instantFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function formatInstant(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : instantFormat.format(date)
}

// A datetime-local input value ("2026-10-08T09:30", the user's local wall time) as an ISO-8601 instant
// for the API; an empty input is null. The backend validates the instant itself.
export function localInputToInstant(value: string) {
  if (value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

// The same instant to the second, for records that may be created moments apart (validation runs,
// readiness assessments) so each one stays distinguishable in a history list.
const preciseInstantFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatInstantPrecise(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : preciseInstantFormat.format(date)
}
