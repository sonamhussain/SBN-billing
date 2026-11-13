import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyNewClosure, buildReconstruction, deriveClosure, eligibilityOf, NO_CLOSURE, reconcileAttempt } from './exception-closure.reducer.ts'
import type { ClosureEventFacts, ClosureEventShape, EscalationFacts, OwnerRecord, ReconstructionInput, ResolutionFacts } from './exception-closure.types.ts'

// A8.9 — the closure gate over every A8.7 × A8.8 position, the closure reducer, whole histories, the unknown-outcome
// reconciliation, the anchored reconstruction, and the same answers under any time zone and locale. Synthetic
// identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RQ = id(701) // A8.7 request
const DC = id(702) // A8.7 confirmation
const RET = id(801) // A8.8 return
const M_REQ = id(901)
const U_REQ = id(911)
const M_DEC = id(902)
const U_DEC = id(912)
const M_C = id(903) // an independent confirmer
const U_C = id(913)
const parent = { exceptionIntakeId: id(1), organizationId: id(2), claimId: id(3) }

const resolved: ResolutionFacts = {
  state: 'RESOLVED_INTERNAL',
  request: { resolutionEventId: RQ, requestedByMembershipId: M_REQ, requestedByUserId: U_REQ },
  decision: { resolutionEventId: DC, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION', decidedByMembershipId: M_DEC, decidedByUserId: U_DEC },
}
const noEscalation: EscalationFacts = { state: 'NO_ESCALATION', returned: null }
const returnedEscalation: EscalationFacts = { state: 'RETURNED_TO_OWNER', returned: { returnEventId: RET, returnReasonCode: 'FOLLOWUP_RECORDED' } }

const closeOn = (o: Partial<ClosureEventShape> = {}): ClosureEventShape => ({
  eventCode: 'CONFIRM_INTERNAL_CLOSURE', resolutionDecisionEventId: DC, closureReasonCode: 'VERIFIED_INTERNAL_RESOLUTION', basisReferenceKind: 'RESOLUTION_DECISION', basisReferenceId: DC,
  basisOwnerContractVersion: 'A8-RESOLUTION-DECISION-1', recordedByMembershipId: M_C, recordedByUserId: U_C, ...o,
})
const closeOnReturn = (o: Partial<ClosureEventShape> = {}) =>
  closeOn({ closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED', basisReferenceKind: 'ESCALATION_RETURN', basisReferenceId: RET, basisOwnerContractVersion: 'A8-ESCALATION-1', ...o })

test('the eligibility gate over every A8.7 × A8.8 position (T031–T040, CL-01, CL-02)', () => {
  const plain = eligibilityOf(resolved, noEscalation)
  assert.ok(plain.ok)
  if (plain.ok) {
    assert.equal(plain.basis.basisReferenceKind, 'RESOLUTION_DECISION')
    assert.equal(plain.basis.basisReferenceId, DC)
    assert.equal(plain.basis.closureReasonCode, 'VERIFIED_INTERNAL_RESOLUTION')
    assert.equal(plain.basis.basisOwnerContractVersion, 'A8-RESOLUTION-DECISION-1')
  }
  const afterReturn = eligibilityOf(resolved, returnedEscalation)
  assert.ok(afterReturn.ok)
  if (afterReturn.ok) {
    assert.equal(afterReturn.basis.basisReferenceKind, 'ESCALATION_RETURN')
    assert.equal(afterReturn.basis.basisReferenceId, RET)
    assert.equal(afterReturn.basis.closureReasonCode, 'TERMINAL_FOLLOWUP_REVIEWED')
  }
  // A return for further work (CL-01, v1), an open escalation (CL-02), a pending, returned or absent resolution, and an
  // unanchored state are each refused.
  for (const [resolution, escalation, why] of [
    [resolved, { state: 'AWAITING_ACKNOWLEDGEMENT', returned: null }, /still outstanding/],
    [resolved, { state: 'FOLLOWUP_ACTIVE', returned: null }, /still outstanding/],
    [resolved, { state: 'RETURNED_TO_OWNER', returned: null }, /does not name its return/],
    [resolved, { state: 'RETURNED_TO_OWNER', returned: { returnEventId: RET, returnReasonCode: 'FURTHER_WORK_REQUIRED' } }, /further work is required \(FURTHER_WORK_REQUIRED\); it is not closed in v1/],
    [resolved, { state: 'RETURNED_TO_OWNER', returned: { returnEventId: RET, returnReasonCode: 'followup_recorded' } }, /does not name a controlled reason/],
    [{ ...resolved, state: 'AWAITING_RESOLUTION_DECISION', decision: null }, noEscalation, /awaits a decision/],
    [{ ...resolved, state: 'RETURNED_FOR_REWORK', decision: { ...resolved.decision!, decisionCode: 'RETURN_FOR_REWORK' } }, noEscalation, /returned for rework/],
    [{ state: 'NO_RESOLUTION_REQUEST', request: null, decision: null }, noEscalation, /no confirmed A8\.7 internal resolution/],
    [{ ...resolved, decision: { ...resolved.decision!, decisionCode: 'RETURN_FOR_REWORK' } }, noEscalation, /does not name its confirmed decision/],
    [{ ...resolved, decision: null }, noEscalation, /does not name its confirmed decision/],
  ] as [ResolutionFacts, EscalationFacts, RegExp][]) {
    const result = eligibilityOf(resolution, escalation)
    assert.equal(result.ok, false, JSON.stringify(escalation))
    if (!result.ok) assert.match(result.detail, why)
  }
})

test('the worked closures, terminal in v1 (T041–T045)', () => {
  const closed = applyNewClosure(NO_CLOSURE, eligibilityOf(resolved, noEscalation), closeOn())
  assert.ok(closed.ok)
  if (closed.ok) {
    assert.equal(closed.derived.state, 'CLOSED_INTERNAL')
    assert.equal(closed.derived.closure?.resolutionDecisionEventId, DC)
    assert.equal(closed.derived.closure?.confirmedByMembershipId, M_C)
    // A repeat — identical or different — is never a second closure.
    for (const again of [closeOn(), closeOn({ recordedByMembershipId: id(904), recordedByUserId: id(914) })]) {
      const repeat = applyNewClosure(closed.derived, eligibilityOf(resolved, noEscalation), again)
      assert.equal(repeat.ok, false)
      if (!repeat.ok) {
        assert.equal(repeat.refusal, 'TRANSITION_REFUSED')
        assert.match(repeat.detail, /terminal in v1/)
      }
    }
  }
  const onReturn = applyNewClosure(NO_CLOSURE, eligibilityOf(resolved, returnedEscalation), closeOnReturn())
  assert.ok(onReturn.ok)
  if (onReturn.ok) assert.equal(onReturn.derived.closure?.basisReferenceKind, 'ESCALATION_RETURN')
})

test('every refused closure (T025, T032–T039, T045)', () => {
  const refused = (eligible: ReturnType<typeof eligibilityOf>, event: ClosureEventShape, refusal: string) => {
    const next = applyNewClosure(NO_CLOSURE, eligible, event)
    assert.equal(next.ok, false, JSON.stringify(event).slice(0, 140))
    if (!next.ok) assert.equal(next.refusal, refusal, next.detail)
  }
  const ok = eligibilityOf(resolved, noEscalation)
  const okReturn = eligibilityOf(resolved, returnedEscalation)
  // Not eligible: no resolution, an open escalation.
  refused(eligibilityOf({ state: 'NO_RESOLUTION_REQUEST', request: null, decision: null }, noEscalation), closeOn(), 'NOT_ELIGIBLE')
  refused(eligibilityOf(resolved, { state: 'FOLLOWUP_ACTIVE', returned: null }), closeOn(), 'NOT_ELIGIBLE')
  // Another decision, or the wrong basis for the intake's position.
  refused(ok, closeOn({ resolutionDecisionEventId: RQ, basisReferenceId: RQ }), 'NOT_ELIGIBLE')
  refused(ok, closeOnReturn(), 'NOT_ELIGIBLE')
  refused(okReturn, closeOn(), 'NOT_ELIGIBLE')
  refused(okReturn, closeOnReturn({ basisReferenceId: id(802) }), 'NOT_ELIGIBLE')
  // D1: never the A8.7 requester or decider, by membership or by user.
  refused(ok, closeOn({ recordedByMembershipId: M_REQ, recordedByUserId: U_REQ }), 'NOT_INDEPENDENT')
  refused(ok, closeOn({ recordedByUserId: U_REQ }), 'NOT_INDEPENDENT')
  refused(ok, closeOn({ recordedByMembershipId: M_DEC }), 'NOT_INDEPENDENT')
  refused(okReturn, closeOnReturn({ recordedByUserId: U_DEC }), 'NOT_INDEPENDENT')
})

test('event shapes are exact (T011–T019, T067)', () => {
  const ok = eligibilityOf(resolved, noEscalation)
  for (const bad of [
    closeOn({ eventCode: 'CLOSE_EXCEPTION' }), closeOn({ eventCode: 'REOPEN' }), closeOn({ resolutionDecisionEventId: null }), closeOn({ resolutionDecisionEventId: 'x' }),
    closeOn({ closureReasonCode: 'PAID' }), closeOn({ closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED' }), closeOn({ basisReferenceKind: 'TRIAGE_EVENT' }), closeOn({ basisReferenceId: null }),
    closeOn({ basisReferenceId: RQ }), closeOn({ basisOwnerContractVersion: 'A8-ESCALATION-1' }), closeOn({ basisOwnerContractVersion: null }), closeOn({ recordedByMembershipId: 'x' }),
    closeOnReturn({ closureReasonCode: 'VERIFIED_INTERNAL_RESOLUTION' }), closeOnReturn({ basisOwnerContractVersion: 'A8-RESOLUTION-DECISION-1' }),
  ]) {
    const next = applyNewClosure(NO_CLOSURE, ok, bad)
    assert.equal(next.ok, false, JSON.stringify(bad).slice(0, 140))
    if (!next.ok) assert.equal(next.refusal, 'SHAPE')
  }
})

const facts = (n: number, event: ClosureEventShape, o: Partial<ClosureEventFacts> = {}): ClosureEventFacts => ({ ...event, id: id(100 + n), ...parent, contractVersion: 'A8-CLOSURE-1', sequence: n, ...o })

test('a whole stored history derives deterministically or is refused entirely (T091–T097)', () => {
  const history = [facts(1, closeOn())]
  const first = JSON.stringify(deriveClosure(parent, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveClosure(parent, history)), first)
  const derived = deriveClosure(parent, history)
  assert.ok(derived.ok)
  if (derived.ok) assert.equal(derived.value.state, 'CLOSED_INTERNAL')
  assert.deepEqual(deriveClosure(parent, []), { ok: true, value: NO_CLOSURE })
  for (const broken of [
    [facts(2, closeOn())], [facts(1, closeOn()), facts(2, closeOn())], [facts(1, closeOn(), { contractVersion: 'A8-CLOSURE-2' })], [facts(1, closeOn(), { organizationId: id(9) })],
    [facts(1, closeOn(), { claimId: id(9) })], [facts(1, closeOn(), { exceptionIntakeId: id(9) })], [facts(1, closeOn(), { id: 'x' })], [facts(1, closeOn({ closureReasonCode: 'PAID' }))],
  ] as ClosureEventFacts[][])
    assert.equal(deriveClosure(parent, broken).ok, false, JSON.stringify(broken).slice(0, 140))
})

test('an unknown outcome is reconciled against the committed history only (T090)', () => {
  const attempted = { ...closeOn(), sequence: 1 }
  assert.deepEqual(reconcileAttempt([], attempted), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([{ ...closeOn(), id: id(61), sequence: 1 }], attempted), { outcome: 'RECORDED', closureEventId: id(61) })
  assert.deepEqual(reconcileAttempt([{ ...closeOn({ recordedByUserId: id(919) }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
})

// A complete synthetic owner chain for the reconstruction.
const rec = (recordId: string, contractVersion: string, sequence: number | null, eventCode: string | null, o: Partial<OwnerRecord> = {}): OwnerRecord => ({ recordId, contractVersion, sequence, eventCode, ...parent, ...o })
const PLAN = id(501)
const VER = id(602)
const chainInput = (o: Partial<ReconstructionInput> = {}): ReconstructionInput => ({
  parent,
  intake: rec(id(1), 'A8-EXCEPTION-INTAKE-1', null, null, { recordId: parent.exceptionIntakeId }),
  triage: [rec(id(201), 'A8-EXCEPTION-TRIAGE-1', 1, 'TRIAGE_CLASSIFY'), rec(id(202), 'A8-EXCEPTION-TRIAGE-1', 2, 'ASSIGN_OWNER')],
  investigation: [rec(id(301), 'A8-EXCEPTION-INVESTIGATION-1', 1, 'LINK_EVIDENCE_REFERENCE'), rec(id(302), 'A8-EXCEPTION-INVESTIGATION-1', 2, 'RECORD_FINDING')],
  remediation: [rec(PLAN, 'A8-REMEDIATION-1', 1, 'PROPOSE_ACTION'), rec(id(502), 'A8-REMEDIATION-1', 2, 'REVIEW_ACTION')],
  work: [rec(id(601), 'A8-REMEDIATION-WORK-1', 1, 'RECORD_WORK_REPORT'), rec(VER, 'A8-REMEDIATION-WORK-1', 2, 'VERIFY_WORK_REPORT')],
  resolution: [rec(RQ, 'A8-RESOLUTION-DECISION-1', 1, 'REQUEST_INTERNAL_RESOLUTION'), rec(DC, 'A8-RESOLUTION-DECISION-1', 2, 'DECIDE_INTERNAL_RESOLUTION')],
  escalation: [],
  closure: [rec(id(901), 'A8-CLOSURE-1', 1, 'CONFIRM_INTERNAL_CLOSURE')],
  recorded: {
    closureEventId: id(901), sequence: 1, resolutionDecisionEventId: DC, closureReasonCode: 'VERIFIED_INTERNAL_RESOLUTION', basisReferenceKind: 'RESOLUTION_DECISION', basisReferenceId: DC,
    basisOwnerContractVersion: 'A8-RESOLUTION-DECISION-1', confirmedByMembershipId: M_C, confirmedByUserId: U_C,
  },
  anchors: { requestVerificationEventId: VER, workVerificationEventId: VER, workApprovedProposalEventId: PLAN, planApprovedProposalEventId: PLAN },
  ...o,
})

test('the reconstruction anchors the recorded closure in every owner history, or refuses whole (T051–T057, T094–T097)', () => {
  const built = buildReconstruction(chainInput())
  assert.ok(built.ok)
  if (built.ok) {
    assert.deepEqual(built.chain.map((e) => e.owner), ['A8.1', 'A8.2', 'A8.2', 'A8.3', 'A8.3', 'A8.5', 'A8.5', 'A8.6', 'A8.6', 'A8.7', 'A8.7', 'A8.9'])
    assert.deepEqual(built.chain.map((e) => e.position), built.chain.map((_e, i) => i + 1))
    assert.equal(built.chain[built.chain.length - 1].recordId, id(901))
  }
  const withReturn = chainInput({
    escalation: [rec(id(851), 'A8-ESCALATION-1', 1, 'ESCALATE_FOR_REVIEW'), rec(id(852), 'A8-ESCALATION-1', 2, 'ACKNOWLEDGE_ESCALATION'), rec(id(853), 'A8-ESCALATION-1', 3, 'RECORD_FOLLOWUP'), rec(RET, 'A8-ESCALATION-1', 4, 'RETURN_TO_OWNER')],
    recorded: { ...chainInput().recorded!, closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED', basisReferenceKind: 'ESCALATION_RETURN', basisReferenceId: RET, basisOwnerContractVersion: 'A8-ESCALATION-1' },
  })
  assert.ok(buildReconstruction(withReturn).ok)
  assert.deepEqual(buildReconstruction(chainInput({ closure: [], recorded: null })), { ok: true, chain: [] })
  const base = chainInput()
  for (const broken of [
    chainInput({ recorded: { ...base.recorded!, resolutionDecisionEventId: RQ } }),
    chainInput({ recorded: { ...base.recorded!, basisReferenceId: RQ } }),
    chainInput({ escalation: [rec(id(851), 'A8-ESCALATION-1', 1, 'ESCALATE_FOR_REVIEW')] }),
    withReturn.escalation && chainInput({ ...withReturn, escalation: withReturn.escalation.slice(0, 3) }),
    chainInput({ anchors: { ...base.anchors, requestVerificationEventId: id(601) } }),
    chainInput({ anchors: { ...base.anchors, planApprovedProposalEventId: id(509) } }),
    chainInput({ triage: [rec(id(201), 'A8-EXCEPTION-TRIAGE-1', 1, 'TRIAGE_CLASSIFY', { organizationId: id(9) })] }),
    chainInput({ investigation: [rec(id(302), 'A8-EXCEPTION-INVESTIGATION-1', 2, 'RECORD_FINDING')] }),
    chainInput({ work: [rec(VER, 'A8-REMEDIATION-WORK-1', 1, 'VERIFY_WORK_REPORT'), rec(VER, 'A8-REMEDIATION-WORK-1', 2, 'VERIFY_WORK_REPORT')] }),
    chainInput({ closure: [] }),
    chainInput({ recorded: null }),
    chainInput({ triage: [] }),
  ])
    assert.equal(buildReconstruction(broken).ok, false, JSON.stringify(broken).slice(0, 120))
})

test('the same answers under any time zone and locale, Arabic UTF-8 safe (T118)', () => {
  const reducer = fileURLToPath(new URL('./exception-closure.reducer.ts', import.meta.url))
  const script = `
    const m = await import(${JSON.stringify(`file:///${reducer.replace(/\\/g, '/')}`)});
    const input = ${JSON.stringify(chainInput())};
    const history = ${JSON.stringify([facts(1, closeOn())])};
    const parentOf = ${JSON.stringify(parent)};
    const label = 'استثناء داخلي';
    process.stdout.write(JSON.stringify({ r: m.buildReconstruction(input), d: m.deriveClosure(parentOf, history), label, date: new Date(0).toISOString() }));
  `
  const outputs = [
    { TZ: 'UTC', LANG: 'en_US.UTF-8' }, { TZ: 'Asia/Dubai', LANG: 'ar_AE.UTF-8' }, { TZ: 'America/New_York', LANG: 'en_US.UTF-8' }, { TZ: 'Asia/Kolkata', LANG: 'hi_IN.UTF-8' },
  ].map((env) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ...env, LC_ALL: env.LANG } }))
  for (const out of outputs) assert.equal(out.status, 0, out.stderr)
  const first = outputs[0].stdout
  for (const out of outputs) assert.equal(out.stdout, first)
  assert.match(first, /استثناء داخلي/)
  assert.match(first, /"date":"1970-01-01T00:00:00\.000Z"/)
})
