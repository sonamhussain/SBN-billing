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
