import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { listOrganizationAuditEvents } from './audit.service.ts'

export const auditRouter = Router()

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

auditRouter.get(
  '/:organizationId/audit-events',
  requireOrganizationPermission(organizationIdFromRouteParam, 'audit.read'),
  async (req, res) => {
    const items = await listOrganizationAuditEvents(organizationIdFromRouteParam(req))
    res.status(200).json({ items })
  },
)
