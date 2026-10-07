import { formatDateOnly } from '../../shared/format/date.ts'
import type { ObservationValue, ObservationValueType } from './encounter-observation.types.ts'

// FE-03 — how a typed fact value is named and shown. Values are displayed exactly as recorded; nothing is
// coerced between types and no value is interpreted.

export const valueTypeLabels: Record<ObservationValueType, string> = {
  TEXT: 'Text',
  DECIMAL: 'Decimal',
  BOOLEAN: 'Yes / No',
  DATE: 'Date',
}

export function displayValue(value: ObservationValue) {
  switch (value.type) {
    case 'TEXT':
      return value.text
    case 'DECIMAL':
      return value.unitCode ? `${value.decimal} ${value.unitCode}` : value.decimal
    case 'BOOLEAN':
      return value.boolean ? 'Yes' : 'No'
    case 'DATE':
      return formatDateOnly(value.date)
  }
}
