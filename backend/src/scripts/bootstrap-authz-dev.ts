import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { permissionCodes } from '../shared/authorization/authorization.types.ts'

const permissionCatalogue: { code: (typeof permissionCodes)[number]; name: string }[] = [
  { code: 'organization.read', name: 'Read Organization' },
  { code: 'organization.update', name: 'Update Organization' },
  { code: 'facility.create', name: 'Create Facility' },
  { code: 'facility.read', name: 'Read Facility' },
  { code: 'facility.update', name: 'Update Facility' },
  { code: 'audit.read', name: 'Read Audit Events' },
  { code: 'clinician.create', name: 'Create Clinician' },
  { code: 'clinician.read', name: 'Read Clinician' },
  { code: 'clinician.update', name: 'Update Clinician' },
  { code: 'specialty.create', name: 'Create Specialty' },
  { code: 'specialty.read', name: 'Read Specialty' },
  { code: 'specialty.update', name: 'Update Specialty' },
  { code: 'payer.create', name: 'Create Payer' },
  { code: 'payer.read', name: 'Read Payer' },
  { code: 'payer.update', name: 'Update Payer' },
  { code: 'tpa.create', name: 'Create TPA' },
  { code: 'tpa.read', name: 'Read TPA' },
  { code: 'tpa.update', name: 'Update TPA' },
  { code: 'network.create', name: 'Create Network' },
  { code: 'network.read', name: 'Read Network' },
  { code: 'network.update', name: 'Update Network' },
  { code: 'service.create', name: 'Create Service' },
  { code: 'service.read', name: 'Read Service' },
  { code: 'service.update', name: 'Update Service' },
  { code: 'procedure_code.create', name: 'Create Procedure Code' },
  { code: 'procedure_code.read', name: 'Read Procedure Code' },
  { code: 'procedure_code.update', name: 'Update Procedure Code' },
  { code: 'diagnosisCode.create', name: 'Create Diagnosis Code' },
  { code: 'diagnosisCode.read', name: 'Read Diagnosis Code' },
  { code: 'diagnosisCode.update', name: 'Update Diagnosis Code' },
  { code: 'external_identifier.create', name: 'Create External Identifier' },
  { code: 'external_identifier.read', name: 'Read External Identifier' },
  { code: 'external_identifier.update', name: 'Update External Identifier' },
  { code: 'rule_source.create', name: 'Create Rule Source' },
  { code: 'rule_source.read', name: 'Read Rule Source' },
  { code: 'rule_source.update', name: 'Update Rule Source' },
  { code: 'rule_source_version.create', name: 'Create Rule Source Version' },
  { code: 'rule_source_version.read', name: 'Read Rule Source Version' },
  { code: 'source_interpretation.create', name: 'Create Source Interpretation' },
  { code: 'source_interpretation.read', name: 'Read Source Interpretation' },
  { code: 'source_interpretation.update', name: 'Update Source Interpretation' },
]

const roleCatalogue = [
  {
    code: 'ORG_ADMIN',
    name: 'Organization Administrator',
    permissions: [
      'organization.read',
      'organization.update',
      'facility.create',
      'facility.read',
      'facility.update',
      'audit.read',
      'clinician.create',
      'clinician.read',
      'clinician.update',
      'specialty.create',
      'specialty.read',
      'specialty.update',
      'payer.create',
      'payer.read',
      'payer.update',
      'tpa.create',
      'tpa.read',
      'tpa.update',
      'network.create',
      'network.read',
      'network.update',
      'service.create',
      'service.read',
      'service.update',
      'procedure_code.create',
      'procedure_code.read',
      'procedure_code.update',
      'diagnosisCode.create',
      'diagnosisCode.read',
      'diagnosisCode.update',
      'external_identifier.create',
      'external_identifier.read',
      'external_identifier.update',
      'rule_source.create',
      'rule_source.read',
      'rule_source.update',
      'rule_source_version.create',
      'rule_source_version.read',
      'source_interpretation.create',
      'source_interpretation.read',
      'source_interpretation.update',
    ],
  },
  {
    code: 'ORG_VIEWER',
    name: 'Organization Viewer',
    permissions: ['organization.read', 'facility.read', 'clinician.read', 'specialty.read', 'payer.read', 'tpa.read', 'network.read', 'service.read', 'procedure_code.read', 'diagnosisCode.read', 'external_identifier.read', 'rule_source.read', 'rule_source_version.read', 'source_interpretation.read'],
  },
] as const

async function main() {
  if (process.env.AUTHZ_DEV_BOOTSTRAP !== 'true') {
    console.log('AUTHZ_DEV_BOOTSTRAP is not "true" — refusing to run. Nothing changed.')
    return
  }

  const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL
  const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID

  if (!userEmail || !organizationId) {
    throw new Error('AUTHZ_BOOTSTRAP_USER_EMAIL and AUTHZ_BOOTSTRAP_ORGANIZATION_ID are required')
  }

  const user = await prisma.user.findUnique({ where: { email: userEmail } })
  if (!user) {
    throw new Error(`No existing Better Auth user found for email: ${userEmail}`)
  }

  const organization = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!organization) {
    throw new Error(`No existing Organization found for id: ${organizationId}`)
  }

  for (const permission of permissionCatalogue) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name },
      create: { code: permission.code, name: permission.name },
    })
  }

  for (const role of roleCatalogue) {
    const savedRole = await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: { code: role.code, name: role.name },
    })

    for (const permissionCode of role.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code: permissionCode } })
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: savedRole.id, permissionId: permission.id } },
        update: {},
        create: { roleId: savedRole.id, permissionId: permission.id },
      })
    }
  }

  const membership = await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId, userId: user.id } },
    update: {},
    create: { organizationId, userId: user.id },
  })

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' } })
  await prisma.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId: membership.id, roleId: adminRole.id } },
    update: {},
    create: { membershipId: membership.id, roleId: adminRole.id },
  })

  console.log('Authorization bootstrap complete.')
  console.log('userId:', user.id)
  console.log('organizationId:', organization.id)
  console.log('membershipId:', membership.id)
  console.log('roleAssigned:', adminRole.code)
}

main()
  .catch((error) => {
    console.error('Bootstrap failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
