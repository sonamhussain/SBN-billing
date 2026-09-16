import { Router, type Request } from 'express'
import type { TariffScheduleErrorCode } from './tariff-schedule.types.ts'
import {
  createTariffSchedule,
  createTariffScheduleVersion,
  getTariffSchedule,
  getTariffScheduleVersion,
  listTariffScheduleVersions,
  listTariffSchedules,
  updateTariffSchedule,
  updateTariffScheduleVersionMetadata,
  updateTariffScheduleVersionVerification,
} from './tariff-schedule.service.ts'
import { findTariffScheduleById, findTariffScheduleVersionWithSchedule } from './tariff-schedule.repository.ts'
import { findProviderContractById } from './provider-contract.repository.ts'
import { isCommercialContextUuid } from './commercial-context.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const providerContractTariffSchedulesRouter = Router()
export const tariffScheduleRouter = Router()
export const tariffScheduleVersionRouter = Router()

function statusForError(code: TariffScheduleErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function contractIdFromParams(req: Request): string {
  return String(req.params.id)
}

function scheduleIdFromParams(req: Request): string {
  return String(req.params.id)
}

function versionIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromParentContract(req: Request): Promise<string | null> {
  const id = contractIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const contract = await findProviderContractById(id)
  return contract?.organizationId ?? null
}

async function organizationIdFromExistingSchedule(req: Request): Promise<string | null> {
  const id = scheduleIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const schedule = await findTariffScheduleById(id)
  if (!schedule) return null
  const contract = await findProviderContractById(schedule.providerContractId)
  return contract?.organizationId ?? null
}

async function organizationIdFromExistingVersion(req: Request): Promise<string | null> {
  const id = versionIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const version = await findTariffScheduleVersionWithSchedule(id)
  return version?.tariffSchedule.providerContract.organizationId ?? null
}

providerContractTariffSchedulesRouter.post(
  '/:id/tariff-schedules',
  requireOrganizationPermission(organizationIdFromParentContract, 'tariff_schedule.create'),
  async (req, res) => {
    const result = await createTariffSchedule(
      contractIdFromParams(req),
      req.body?.tariffKey,
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

providerContractTariffSchedulesRouter.get(
  '/:id/tariff-schedules',
  requireOrganizationPermission(organizationIdFromParentContract, 'tariff_schedule.read'),
  async (req, res) => {
    const result = await listTariffSchedules(contractIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

tariffScheduleRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingSchedule, 'tariff_schedule.read'),
  async (req, res) => {
    const result = await getTariffSchedule(scheduleIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

tariffScheduleRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingSchedule, 'tariff_schedule.update'),
  async (req, res) => {
    const result = await updateTariffSchedule(scheduleIdFromParams(req), req.body?.displayName, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

tariffScheduleRouter.post(
  '/:id/versions',
  requireOrganizationPermission(organizationIdFromExistingSchedule, 'tariff_schedule_version.create'),
  async (req, res) => {
    const result = await createTariffScheduleVersion(
      scheduleIdFromParams(req),
      req.body?.version,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

tariffScheduleRouter.get(
  '/:id/versions',
  requireOrganizationPermission(organizationIdFromExistingSchedule, 'tariff_schedule_version.read'),
  async (req, res) => {
    const result = await listTariffScheduleVersions(scheduleIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

tariffScheduleVersionRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'tariff_schedule_version.read'),
  async (req, res) => {
    const result = await getTariffScheduleVersion(versionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

tariffScheduleVersionRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'tariff_schedule_version.lifecycle'),
  async (req, res) => {
    const result = await updateTariffScheduleVersionMetadata(
      versionIdFromParams(req),
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

tariffScheduleVersionRouter.post(
  '/:id/verification',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'tariff_schedule_version.lifecycle'),
  async (req, res) => {
    const result = await updateTariffScheduleVersionVerification(
      versionIdFromParams(req),
      req.body?.verificationStatus,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
