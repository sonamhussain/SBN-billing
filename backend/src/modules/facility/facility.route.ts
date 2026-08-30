import { Router, type Response } from 'express'
import type { FacilityErrorCode } from './facility.types.ts'
import { createFacility, getFacility, updateFacility } from './facility.service.ts'

export const organizationFacilityRouter = Router()
export const facilityRouter = Router()

function sendError(res: Response, code: FacilityErrorCode, message: string) {
  res.status(code === 'NOT_FOUND' ? 404 : 400).json({ error: { code, message } })
}

organizationFacilityRouter.post('/:organizationId/facilities', async (req, res) => {
  const result = await createFacility(req.params.organizationId, req.body?.name)
  if (!result.ok) { sendError(res, result.code, result.message); return }
  res.status(201).json(result.value)
})

facilityRouter.get('/:id', async (req, res) => {
  const result = await getFacility(req.params.id)
  if (!result.ok) { sendError(res, result.code, result.message); return }
  res.status(200).json(result.value)
})

facilityRouter.patch('/:id', async (req, res) => {
  const result = await updateFacility(req.params.id, req.body?.name)
  if (!result.ok) { sendError(res, result.code, result.message); return }
  res.status(200).json(result.value)
})
