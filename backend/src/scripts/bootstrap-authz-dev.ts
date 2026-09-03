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
    ],
  },
  {
    code: 'ORG_VIEWER',
    name: 'Organization Viewer',
    permissions: ['organization.read', 'facility.read'],
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
