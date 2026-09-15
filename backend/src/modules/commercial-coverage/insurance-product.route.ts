import { Router, type Request } from 'express'
import type { InsuranceProductErrorCode } from './insurance-product.types.ts'
import {
  createInsuranceProduct,
  createProductNetwork,
  getInsuranceProduct,
  getProductNetwork,
  listInsuranceProducts,
  listProductNetworks,
  updateInsuranceProduct,
} from './insurance-product.service.ts'
import { findInsuranceProductById, findProductNetworkWithProduct } from './insurance-product.repository.ts'
import { isCommercialContextUuid } from './commercial-context.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationInsuranceProductRouter = Router()
export const insuranceProductRouter = Router()
export const productNetworkRouter = Router()

function statusForError(code: InsuranceProductErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function productIdFromParams(req: Request): string {
  return String(req.params.id)
}

function productNetworkIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingProduct(req: Request): Promise<string | null> {
  const id = productIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const product = await findInsuranceProductById(id)
  return product?.organizationId ?? null
}

async function organizationIdFromExistingProductNetwork(req: Request): Promise<string | null> {
  const id = productNetworkIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const productNetwork = await findProductNetworkWithProduct(id)
  return productNetwork?.insuranceProduct.organizationId ?? null
}

organizationInsuranceProductRouter.post(
  '/:organizationId/insurance-products',
  requireOrganizationPermission(organizationIdFromRouteParam, 'insurance_product.create'),
  async (req, res) => {
    const result = await createInsuranceProduct(
      organizationIdFromRouteParam(req),
      req.body?.payerId,
      req.body?.productCode,
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

organizationInsuranceProductRouter.get(
  '/:organizationId/insurance-products',
  requireOrganizationPermission(organizationIdFromRouteParam, 'insurance_product.read'),
  async (req, res) => {
    const result = await listInsuranceProducts(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

insuranceProductRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProduct, 'insurance_product.read'),
  async (req, res) => {
    const result = await getInsuranceProduct(productIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

insuranceProductRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProduct, 'insurance_product.update'),
  async (req, res) => {
    const result = await updateInsuranceProduct(productIdFromParams(req), req.body?.displayName, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

insuranceProductRouter.post(
  '/:id/product-networks',
  requireOrganizationPermission(organizationIdFromExistingProduct, 'product_network.create'),
  async (req, res) => {
    const result = await createProductNetwork(productIdFromParams(req), req.body?.networkId, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

insuranceProductRouter.get(
  '/:id/product-networks',
  requireOrganizationPermission(organizationIdFromExistingProduct, 'product_network.read'),
  async (req, res) => {
    const result = await listProductNetworks(productIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

productNetworkRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProductNetwork, 'product_network.read'),
  async (req, res) => {
    const result = await getProductNetwork(productNetworkIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
