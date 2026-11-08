// One interactive transaction is one pg client, and a pg client runs one query at a time. Prisma 7 can hand a
// transaction several queries at once — an explicit Promise.all on `tx`, or one read whose relations it loads in
// parallel — and pg then queues them itself while warning that this implicit queue is deprecated (it is removed in
// pg@9: "Calling client.query() when the client is already executing a query"). Here that queue is explicit: every
// statement of one transaction is passed to the driver strictly after the previous one has settled, in the order it
// was issued. Nothing else changes — the same client, the same isolation level and snapshot, the same statements, the
// same order pg already ran them in, the same results and errors. Statements outside a transaction use the pool and
// are not touched.

type Driver = { startTransaction: (...args: never[]) => Promise<object> }
type Factory = { connect: (...args: never[]) => Promise<object> }

// The transaction methods that send a statement on the transaction's client (COMMIT and ROLLBACK are statements
// Prisma sends through executeRaw before it calls commit/rollback, which release the client).
const STATEMENT_METHODS = new Set<PropertyKey>(['queryRaw', 'executeRaw', 'createSavepoint', 'rollbackToSavepoint', 'releaseSavepoint', 'commit', 'rollback'])

export function serializeTransaction<T extends object>(transaction: T): T {
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = (work: () => Promise<unknown>) => {
    const next = tail.then(work, work)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  return new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (STATEMENT_METHODS.has(property)) return (...args: unknown[]) => enqueue(() => Promise.resolve(value.apply(target, args)))
      return value.bind(target)
    },
  })
}

// A driver whose every transaction is serialized as above; every other member is the driver's own.
export function withSerializedTransactions<T extends Driver>(driver: T): T {
  return new Proxy(driver, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'startTransaction') return async (...args: never[]) => serializeTransaction(await value.apply(target, args))
      return value.bind(target)
    },
  })
}

// An adapter factory whose connected drivers serialize their transactions.
export function serializedAdapter<T extends Factory>(factory: T): T {
  return new Proxy(factory, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'connect') return async (...args: never[]) => withSerializedTransactions((await value.apply(target, args)) as Driver)
      return value.bind(target)
    },
  })
}
