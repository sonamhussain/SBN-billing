import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findTariffRateOwnership, findTariffVersionScope } from './tariff-rate.repository.ts'
import { createTariffRate, listTariffRates, retireTariffRate } from './tariff-rate.service.ts'
import type { TariffRateErrorCode, TariffRateResult } from './tariff-rate.types.ts'
import { isTariffRateUuid } from './tariff-rate.validation.ts'

// A6.3 §9 — tariff rate routes. Ownership resolves through version -> schedule -> contract ->
// Organization before any work; another tenant's version or rate is answered exactly like a missing one
// (404), so neither its existence nor a fee is disclosed.
// There is no DELETE and no edit: a rate is created, read, or retired once.

export const tariffVersionRatesRouter = Router()
export const tariffRateRouter = Router()

const statusFor = (code: TariffRateErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: TariffRateResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isTariffRateUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromVersion(req: Request): Promise<string | null> {
  return (await findTariffVersionScope(String(req.params.versionId)))?.organizationId ?? null
}

async function organizationIdFromRate(req: Request): Promise<string | null> {
  return (await findTariffRateOwnership(String(req.params.rateId)))?.organizationId ?? null
}

tariffVersionRatesRouter.post('/:versionId/rates', requireUuidParam('versionId', 'tariff schedule version'), requireMemberPermission(organizationIdFromVersion, 'tariffRate.create'), async (req, res) => {
  send(res, await createTariffRate(String(req.params.versionId), req.body, String(res.locals.actorUserId)), 201)
})

tariffVersionRatesRouter.get('/:versionId/rates', requireUuidParam('versionId', 'tariff schedule version'), requireMemberPermission(organizationIdFromVersion, 'tariffRate.read'), async (req, res) => {
  send(res, await listTariffRates(String(req.params.versionId)), 200)
})

tariffRateRouter.post('/:rateId/retire', requireUuidParam('rateId', 'tariff rate'), requireMemberPermission(organizationIdFromRate, 'tariffRate.update'), async (req, res) => {
  send(res, await retireTariffRate(String(req.params.rateId), req.body, String(res.locals.actorUserId)), 200)
})
