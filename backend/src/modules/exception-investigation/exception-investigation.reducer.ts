import {
  type AttemptedInvestigationEvent,
  EVIDENCE_CONTRACT_OF,
  INVESTIGATION_CONTRACT_VERSION,
  evidenceKinds,
  findingCodes,
  intakeBasisCodes,
  type DerivationResult,
  type EvidenceKind,
  type FindingCode,
  type InvestigationEventFacts,
  type InvestigationEventShape,
  type InvestigationParent,
  type InvestigationState,
  type ReconciledOutcome,
  type TransitionResult,
} from './exception-investigation.types.ts'

// A8.3 §3/§6 — the one pure, deterministic investigation reducer. It reads an event's controlled content and the
// investigation before it, and answers the investigation after it or a refusal. It never reads a clock, locale,
// database or network, never orders by time or identifier, and never repairs: an event of the wrong shape, a finding
// whose link is not an earlier link of this intake, a gap, a reused or out-of-order sequence, another intake's or
// tenant's event or an unknown contract is a refusal.
//
//   any state + LINK_EVIDENCE_REFERENCE(kind, record, contract) -> the link appended (a record already linked under
//                                                                  that kind is refused: D18)
//   any state + RECORD_FINDING(link, finding)                   -> the finding appended, if the link is an earlier
//                                                                  link of this intake and the finding is not exactly
//                                                                  the latest one (same code, same link: D18)
//   NOT_STARTED with no event; EVIDENCE_LINKED with links and no finding; FINDING_RECORDED once a finding exists.
// Whether the actor may write at all (the current A8.2 assignee) and whether the record exists for this intake are the
// service's and the database's to hold; the reducer judges only the history itself.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isKind = (value: unknown): value is EvidenceKind => typeof value === 'string' && (evidenceKinds as readonly string[]).includes(value)
const isFinding = (value: unknown): value is FindingCode => typeof value === 'string' && (findingCodes as readonly string[]).includes(value)
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)

export const NOT_STARTED: InvestigationState = { investigationCode: 'NOT_STARTED', links: [], findings: [], lastSequence: 0 }

// The exact shape of each event: its own attributes present and controlled, every other attribute null. A link
// carries its kind's one contract, and a basis code exactly when it links the intake's basis.
function shapeRefusal(event: InvestigationEventShape): string | null {
  const { eventCode, evidenceKind, evidenceRecordId, evidenceContractVersion, evidenceBasisCode, linkedEvidenceEventId, findingCode } = event
  if (eventCode === 'LINK_EVIDENCE_REFERENCE') {
    const basisOk = evidenceKind === 'INTAKE_BASIS' ? typeof evidenceBasisCode === 'string' && (intakeBasisCodes as readonly string[]).includes(evidenceBasisCode) : evidenceBasisCode === null
    return isKind(evidenceKind) && isUuid(evidenceRecordId) && evidenceContractVersion === EVIDENCE_CONTRACT_OF[evidenceKind] && basisOk && linkedEvidenceEventId === null && findingCode === null
      ? null
      : "an evidence link carries exactly a controlled kind, one record, that kind's contract and, for the intake basis, its basis code"
  }
  if (eventCode === 'RECORD_FINDING')
    return isUuid(linkedEvidenceEventId) && isFinding(findingCode) && evidenceKind === null && evidenceRecordId === null && evidenceContractVersion === null && evidenceBasisCode === null
      ? null
      : 'a finding carries exactly one linked evidence event and a controlled finding code'
  return 'the event code is not a controlled investigation event'
}

const codeOf = (links: readonly unknown[], findings: readonly unknown[]) => (findings.length > 0 ? 'FINDING_RECORDED' : links.length > 0 ? 'EVIDENCE_LINKED' : 'NOT_STARTED')

// The next event, given the investigation before it. `id` is the event's own stored id (null for an event not yet
// written): a later finding names a link by it.
export function applyInvestigationEvent(state: InvestigationState, event: InvestigationEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return { ok: false, detail: shape }
  const sequence = state.lastSequence + 1
  if (event.eventCode === 'LINK_EVIDENCE_REFERENCE') {
    if (state.links.some((link) => link.evidenceKind === event.evidenceKind && link.evidenceRecordId === event.evidenceRecordId))
      return { ok: false, detail: 'this evidence record is already linked; an identical link is not recorded again' }
    const link = { investigationEventId: id ?? '', sequence, evidenceKind: event.evidenceKind as EvidenceKind, evidenceRecordId: event.evidenceRecordId as string, evidenceContractVersion: event.evidenceContractVersion as string, evidenceBasisCode: event.evidenceBasisCode }
    const links = [...state.links, link]
    return { ok: true, state: { investigationCode: codeOf(links, state.findings), links, findings: state.findings, lastSequence: sequence } }
  }
  if (!state.links.some((link) => link.investigationEventId === event.linkedEvidenceEventId))
    return { ok: false, detail: 'a finding names an earlier evidence link of this exception' }
  const latest = state.findings[state.findings.length - 1]
  if (latest && latest.findingCode === event.findingCode && latest.linkedEvidenceEventId === event.linkedEvidenceEventId)
    return { ok: false, detail: 'the finding repeats the latest finding unchanged; an identical repeat is not recorded' }
  const findings = [...state.findings, { investigationEventId: id ?? '', sequence, findingCode: event.findingCode as FindingCode, linkedEvidenceEventId: event.linkedEvidenceEventId as string }]
  return { ok: true, state: { investigationCode: codeOf(state.links, findings), links: state.links, findings, lastSequence: sequence } }
}

// §6 — the investigation of one intake from its stored events, in the order the store returned them. Every event must
// belong to exactly this intake, organization and Claim, under this contract, numbered exactly 1..N in that order,
// and each must be a legal next step; anything else refuses the whole history (never a partial or guessed view).
export function deriveInvestigation(parent: InvestigationParent, events: readonly InvestigationEventFacts[]): DerivationResult {
  let state = NOT_STARTED
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'an investigation event belongs to another intake, organization or claim' }
    if (event.contractVersion !== INVESTIGATION_CONTRACT_VERSION) return { ok: false, detail: 'an investigation event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the investigation events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'an investigation event has no valid identity' }
    const next = applyInvestigationEvent(state, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    state = next.state
  }
  return { ok: true, value: state }
}

// An attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event at
// the attempted number is exactly this one (membership, actor and every controlled field), OTHER_EVENT when another
// event holds that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to
// write again.
export function reconcileAttempt(
  committed: readonly (InvestigationEventShape & { id: string; sequence: number; recordedByMembershipId: string; recordedByUserId: string })[],
  attempted: AttemptedInvestigationEvent,
): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const exact =
    atNumber.length === 1 &&
    event.eventCode === attempted.eventCode &&
    event.evidenceKind === attempted.evidenceKind &&
    event.evidenceRecordId === attempted.evidenceRecordId &&
    event.evidenceContractVersion === attempted.evidenceContractVersion &&
    event.evidenceBasisCode === attempted.evidenceBasisCode &&
    event.linkedEvidenceEventId === attempted.linkedEvidenceEventId &&
    event.findingCode === attempted.findingCode &&
    event.recordedByMembershipId === attempted.recordedByMembershipId &&
    event.recordedByUserId === attempted.recordedByUserId
  return exact ? { outcome: 'RECORDED', investigationEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
