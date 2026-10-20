import test from 'node:test'
import assert from 'node:assert/strict'
import { admitCorrectionLink, orderCorrectionChain, type ChainLink, type FreezeFacts } from './claim-correction.chain.ts'
import { validateCorrectionLinkBody } from './claim-correction.validation.ts'

// A6.9 — the pure correction chain, admission rules and strict request. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const link = (n: number, prior: number, corrected: number): ChainLink => ({ id: id(900 + n), priorSubmissionId: id(prior), correctedSubmissionId: id(corrected) })
const freeze = (n: number, at: number, assessment = n, claim = 1): FreezeFacts => ({ id: id(n), claimId: id(claim), draftAssessmentId: id(500 + assessment), frozenAtMicros: at })

test('no link is an empty chain', () => {
  assert.deepEqual(orderCorrectionChain([]), { ok: true, links: [], submissions: [] })
})

test('the worked example S1 -> S2 -> S3 orders root to tail, whatever the input order', () => {
  for (const links of [[link(1, 1, 2), link(2, 2, 3)], [link(2, 2, 3), link(1, 1, 2)]]) {
    const chain = orderCorrectionChain(links)
    assert.ok(chain.ok)
    if (chain.ok) {
      assert.deepEqual(chain.submissions, [id(1), id(2), id(3)])
      assert.deepEqual(chain.links.map((l) => l.id), [id(901), id(902)])
    }
  }
})

test('a long chain is ordered by its links, never by identifier', () => {
  const links = [link(1, 7, 3), link(2, 3, 9), link(3, 9, 1), link(4, 1, 5)]
  const chain = orderCorrectionChain([...links].reverse())
  assert.ok(chain.ok && chain.submissions.join() === [id(7), id(3), id(9), id(1), id(5)].join())
})

test('self links, forks, joins, cycles and two chains are refused', () => {
  const graphs: [string, ChainLink[]][] = [
    ['self', [link(1, 1, 1)]],
    ['fork', [link(1, 1, 2), link(2, 1, 3)]],
    ['join', [link(1, 1, 3), link(2, 2, 3)]],
    ['two-cycle', [link(1, 1, 2), link(2, 2, 1)]],
    ['three-cycle', [link(1, 1, 2), link(2, 2, 3), link(3, 3, 1)]],
    ['two chains', [link(1, 1, 2), link(2, 3, 4)]],
    ['chain plus cycle', [link(1, 1, 2), link(2, 3, 4), link(3, 4, 3)]],
  ]
  for (const [label, links] of graphs) assert.equal(orderCorrectionChain(links).ok, false, label)
})

test('the first link may join any two distinct, later-frozen freezes of the Claim', () => {
  assert.deepEqual(admitCorrectionLink([], freeze(1, 1000), freeze(2, 2000)), { ok: true })
})

test('chronology: the correction must be frozen strictly after the prior; equal is ambiguous', () => {
  assert.equal(admitCorrectionLink([], freeze(1, 2000), freeze(2, 1000)).ok, false)
  assert.equal(admitCorrectionLink([], freeze(1, 2000), freeze(2, 2000)).ok, false)
  assert.equal(admitCorrectionLink([], freeze(1, Number.NaN), freeze(2, 2000)).ok, false)
})

test('identity: distinct freezes, the same Claim, distinct draft assessments', () => {
  assert.equal(admitCorrectionLink([], freeze(1, 1000), freeze(1, 2000)).ok, false)
  assert.equal(admitCorrectionLink([], freeze(1, 1000), freeze(2, 2000, 2, 9)).ok, false)
  assert.equal(admitCorrectionLink([], freeze(1, 1000, 7), freeze(2, 2000, 7)).ok, false)
})

test('the chain grows only at its tail; nothing already in the chain is re-used', () => {
  const chain = [id(1), id(2)]
  assert.deepEqual(admitCorrectionLink(chain, freeze(2, 2000), freeze(3, 3000)), { ok: true })
  assert.equal(admitCorrectionLink(chain, freeze(1, 1000), freeze(3, 3000)).ok, false, 'second correction of the root (fork)')
  assert.equal(admitCorrectionLink(chain, freeze(4, 500), freeze(3, 3000)).ok, false, 'a new, separate chain')
  assert.equal(admitCorrectionLink(chain, freeze(2, 2000), freeze(1, 3000)).ok, false, 'a cycle back to the root')
  assert.equal(admitCorrectionLink(chain, freeze(0, 100), freeze(1, 1000)).ok, false, 'a prepend (join at the root)')
})

test('the request is exactly { priorSubmissionId, correctedSubmissionId, reasonCode }', () => {
  assert.deepEqual(validateCorrectionLinkBody({ priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: 'CORRECTED_CODING' }), {
    ok: true,
    value: { priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: 'CORRECTED_CODING' },
  })
  const upper = 'ABCDEF00-0000-4000-8000-000000000001'
  const normalized = validateCorrectionLinkBody({ priorSubmissionId: upper, correctedSubmissionId: id(2), reasonCode: 'INTERNAL_OTHER' })
  assert.ok(normalized.ok && normalized.value.priorSubmissionId === upper.toLowerCase())
  for (const body of [
    undefined,
    null,
    [],
    {},
    { priorSubmissionId: id(1), correctedSubmissionId: id(2) },
    { priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: 'typo fixed' },
    { priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: null },
    { priorSubmissionId: 'nope', correctedSubmissionId: id(2), reasonCode: 'CORRECTED_CODING' },
    { priorSubmissionId: id(1), correctedSubmissionId: id(1), reasonCode: 'CORRECTED_CODING' },
    { priorSubmissionId: id(1), correctedSubmissionId: upper.replace('ABCDEF00', '00000000'), reasonCode: 'CORRECTED_CODING' },
    { priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: 'CORRECTED_CODING', extra: 1 },
  ])
    assert.equal(validateCorrectionLinkBody(body).ok, false, JSON.stringify(body))
})

test('server-owned, transport and free-text fields are refused by name', () => {
  for (const field of ['claimId', 'recordedByUserId', 'recordedAt', 'contractVersion', 'status', 'note', 'reason', 'payer', 'destination', 'externalReference', 'resubmissionId']) {
    const outcome = validateCorrectionLinkBody({ priorSubmissionId: id(1), correctedSubmissionId: id(2), reasonCode: 'CORRECTED_CODING', [field]: 'x' })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(`^${field} cannot be supplied`))
  }
})
