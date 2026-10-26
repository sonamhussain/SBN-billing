import { isClaimStructureUuid } from '../claim-line/claim-line.validation.ts'

// A7.6 §4 — the only request input is the assessment id in the path. There is no body and no query parameter: the
// assessment, its case, the items, the codes and the instant all come from the owners' stored facts.

export const isTraceUuid = (value: unknown): value is string => isClaimStructureUuid(value)
