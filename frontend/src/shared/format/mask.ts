// FE-02 — member and policy identifiers are masked wherever they are only being recognised; the full
// value appears only in an explicit create/edit form for an authorized user.
export function maskIdentifier(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}
