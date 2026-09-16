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
  { code: 'rule_source_version.lifecycle', name: 'Manage Rule Source Version Lifecycle' },
  { code: 'rule_source_relationship.create', name: 'Create Rule Source Relationship' },
  { code: 'rule_source_relationship.read', name: 'Read Rule Source Relationship' },
  { code: 'rule_definition.create', name: 'Create Rule Definition' },
  { code: 'rule_definition.read', name: 'Read Rule Definition' },
  { code: 'rule_definition.update', name: 'Update Rule Definition' },
  { code: 'rule_version.create', name: 'Create Rule Version' },
  { code: 'rule_version.read', name: 'Read Rule Version' },
  { code: 'rule_version.update', name: 'Update Rule Version' },
  { code: 'rule_version.verify', name: 'Verify Rule Version' },
  { code: 'rule_applicability.create', name: 'Create Rule Applicability' },
  { code: 'rule_applicability.read', name: 'Read Rule Applicability' },
  { code: 'rule_source_binding.create', name: 'Create Rule Source Binding' },
  { code: 'rule_source_binding.read', name: 'Read Rule Source Binding' },
  { code: 'rule_executability.evaluate', name: 'Evaluate Rule Executability' },
  { code: 'facility_regulatory_profile.create', name: 'Create Facility Regulatory Profile' },
  { code: 'facility_regulatory_profile.read', name: 'Read Facility Regulatory Profile' },
  { code: 'facility_regulatory_profile.update', name: 'Update Facility Regulatory Profile' },
  { code: 'facility_regulatory_profile.activate', name: 'Activate Facility Regulatory Profile' },
  { code: 'insurance_product.create', name: 'Create Insurance Product' },
  { code: 'insurance_product.read', name: 'Read Insurance Product' },
  { code: 'insurance_product.update', name: 'Update Insurance Product' },
  { code: 'product_network.create', name: 'Create Product Network' },
  { code: 'product_network.read', name: 'Read Product Network' },
  { code: 'provider_contract.create', name: 'Create Provider Contract' },
  { code: 'provider_contract.read', name: 'Read Provider Contract' },
  { code: 'provider_contract.update', name: 'Update Provider Contract' },
  { code: 'contract_facility.create', name: 'Create Contract Facility' },
  { code: 'contract_facility.read', name: 'Read Contract Facility' },
  { code: 'tariff_schedule.create', name: 'Create Tariff Schedule' },
  { code: 'tariff_schedule.read', name: 'Read Tariff Schedule' },
  { code: 'tariff_schedule.update', name: 'Update Tariff Schedule' },
  { code: 'tariff_schedule_version.create', name: 'Create Tariff Schedule Version' },
  { code: 'tariff_schedule_version.read', name: 'Read Tariff Schedule Version' },
  { code: 'tariff_schedule_version.lifecycle', name: 'Manage Tariff Schedule Version Lifecycle' },
  { code: 'reference_dataset.read', name: 'Read Reference Dataset' },
  { code: 'rule_source_scope.create', name: 'Create Rule Source Scope' },
  { code: 'rule_source_scope.read', name: 'Read Rule Source Scope' },
  { code: 'rule_resolution.read', name: 'Read Deterministic Rule Resolution' },
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
      'rule_source_version.lifecycle',
      'rule_source_relationship.create',
      'rule_source_relationship.read',
      'rule_definition.create',
      'rule_definition.read',
      'rule_definition.update',
      'rule_version.create',
      'rule_version.read',
      'rule_version.update',
      'rule_version.verify',
      'rule_applicability.create',
      'rule_applicability.read',
      'rule_source_binding.create',
      'rule_source_binding.read',
      'rule_executability.evaluate',
      'facility_regulatory_profile.create',
      'facility_regulatory_profile.read',
      'facility_regulatory_profile.update',
      'facility_regulatory_profile.activate',
      'insurance_product.create',
      'insurance_product.read',
      'insurance_product.update',
      'product_network.create',
      'product_network.read',
      'provider_contract.create',
      'provider_contract.read',
      'provider_contract.update',
      'contract_facility.create',
      'contract_facility.read',
      'tariff_schedule.create',
      'tariff_schedule.read',
      'tariff_schedule.update',
      'tariff_schedule_version.create',
      'tariff_schedule_version.read',
      'tariff_schedule_version.lifecycle',
      'reference_dataset.read',
      'rule_source_scope.create',
      'rule_source_scope.read',
      'rule_resolution.read',
    ],
  },
  {
    code: 'ORG_VIEWER',
    name: 'Organization Viewer',
    permissions: ['organization.read', 'facility.read', 'clinician.read', 'specialty.read', 'payer.read', 'tpa.read', 'network.read', 'service.read', 'procedure_code.read', 'diagnosisCode.read', 'external_identifier.read', 'rule_source.read', 'rule_source_version.read', 'source_interpretation.read', 'rule_source_relationship.read', 'rule_definition.read', 'rule_version.read', 'rule_applicability.read', 'rule_source_binding.read', 'rule_executability.evaluate', 'facility_regulatory_profile.read', 'insurance_product.read', 'product_network.read', 'provider_contract.read', 'contract_facility.read', 'tariff_schedule.read', 'tariff_schedule_version.read', 'reference_dataset.read', 'rule_source_scope.read', 'rule_resolution.read'],
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
