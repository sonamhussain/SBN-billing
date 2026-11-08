import test from 'node:test'
import assert from 'node:assert/strict'
import { serializedAdapter, serializeTransaction } from './serialized-transactions.ts'

// CRG-01 Checkpoint B review — the driver-level serialization of one interactive transaction's statements: never two
// in flight, issue order kept, results and errors unchanged, a failed statement does not block the next, members that
// send no statement untouched, and only transactions (never the pool) wrapped.

class FakeTransaction {
  readonly options = { usePhantomQuery: false }
  inFlight = 0
  maxInFlight = 0
  readonly order: string[] = []
  #secret = 'private fields still work'
  private async statement(label: string, ms: number, fail = false) {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    this.order.push(`start ${label}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    this.order.push(`end ${label}`)
    this.inFlight -= 1
    if (fail) throw new Error(`failed ${label}`)
    return { label }
  }
  queryRaw(query: { sql: string; ms: number; fail?: boolean }) {
    return this.statement(query.sql, query.ms, query.fail)
  }
  executeRaw(query: { sql: string; ms: number }) {
    return this.statement(query.sql, query.ms).then(() => 1)
  }
  async createSavepoint(name: string) {
    return this.executeRaw({ sql: `SAVEPOINT ${name}`, ms: 1 })
  }
  async commit() {
    this.order.push('commit')
  }
  secret() {
    return this.#secret
  }
}

test('one transaction runs its statements one at a time, in issue order, with the same results', async () => {
  const raw = new FakeTransaction()
  const tx = serializeTransaction(raw)
  const results = await Promise.all([tx.queryRaw({ sql: 'A', ms: 30 }), tx.queryRaw({ sql: 'B', ms: 1 }), tx.executeRaw({ sql: 'C', ms: 10 }), tx.createSavepoint('s1')])
  await tx.commit()
  assert.equal(raw.maxInFlight, 1)
  assert.deepEqual(raw.order, ['start A', 'end A', 'start B', 'end B', 'start C', 'end C', 'start SAVEPOINT s1', 'end SAVEPOINT s1', 'commit'])
  assert.deepEqual(results, [{ label: 'A' }, { label: 'B' }, 1, 1])
})

test('an error is the statement’s own and the next statement still runs', async () => {
  const raw = new FakeTransaction()
  const tx = serializeTransaction(raw)
  const [failed, after] = await Promise.allSettled([tx.queryRaw({ sql: 'X', ms: 5, fail: true }), tx.queryRaw({ sql: 'Y', ms: 1 })])
  assert.equal(failed.status, 'rejected')
  assert.match(String((failed as PromiseRejectedResult).reason), /failed X/)
  assert.deepEqual(after, { status: 'fulfilled', value: { label: 'Y' } })
  assert.equal(raw.maxInFlight, 1)
})

test('members that send no statement are the transaction’s own, private fields included', () => {
  const raw = new FakeTransaction()
  const tx = serializeTransaction(raw)
  assert.equal(tx.options, raw.options)
  assert.equal(tx.secret(), 'private fields still work')
})

test('the adapter wraps transactions only; the pool and other members are untouched', async () => {
  const pooled = { queryRaw: async () => 'pool', startTransaction: async () => new FakeTransaction(), provider: 'postgres', adapterName: '@prisma/adapter-pg' }
  const factory = { provider: 'postgres', adapterName: '@prisma/adapter-pg', connect: async () => pooled }
  const adapter = serializedAdapter(factory)
  assert.equal(adapter.provider, 'postgres')
  assert.equal(adapter.adapterName, '@prisma/adapter-pg')
  const driver = await adapter.connect()
  assert.equal(driver.provider, 'postgres')
  assert.equal(await driver.queryRaw(), 'pool')
  const tx = (await driver.startTransaction()) as FakeTransaction
  await Promise.all([tx.queryRaw({ sql: 'P', ms: 10 }), tx.queryRaw({ sql: 'Q', ms: 1 })])
  assert.equal((tx as FakeTransaction).maxInFlight, 1)
})
