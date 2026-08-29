import { Router, type Response } from 'express'
import type { ServiceErrorCode } from './organization.types.ts'
import {
  createOrganization,
  getOrganization,
  updateOrganization,
} from './organization.service.ts'

const organizationRouter = Router()

function sendError(
  res: Response,
  code: ServiceErrorCode,
  message: string,
) {
  const status = code === 'NOT_FOUND' ? 404 : 400
  res.status(status).json({ error: { code, message } })
}

organizationRouter.post('/', async (req, res) => {
  const result = await createOrganization(req.body?.name)

  if (!result.ok) {
    sendError(res, result.code, result.message)
    return
  }

  res.status(201).json(result.value)
})

organizationRouter.get('/:id', async (req, res) => {
  const result = await getOrganization(req.params.id)

  if (!result.ok) {
    sendError(res, result.code, result.message)
    return
  }

  res.status(200).json(result.value)
})

organizationRouter.patch('/:id', async (req, res) => {
  const result = await updateOrganization(req.params.id, req.body?.name)

  if (!result.ok) {
    sendError(res, result.code, result.message)
    return
  }

  res.status(200).json(result.value)
})

export default organizationRouter
