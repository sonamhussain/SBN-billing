import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { createOrganization } from '../modules/organization/organization.service.ts'

// Local development only. Organization provisioning sits above the organization-scoped RBAC model, so it
// has no HTTP route. This creates the Organization alone, through the same validation and create path the
// Organization module owns, and prints its id for the authorization bootstrap. It writes no membership,
// role or audit event: no tenant actor exists yet to attribute one to.
async function main() {
  if (process.env.ORGANIZATION_DEV_PROVISION !== 'true') {
    console.log('ORGANIZATION_DEV_PROVISION is not "true" — refusing to run. Nothing changed.')
    return
  }

  const result = await createOrganization(process.env.ORGANIZATION_PROVISION_NAME)

  if (!result.ok) {
    throw new Error(`ORGANIZATION_PROVISION_NAME is invalid: ${result.message}`)
  }

  console.log('Organization provisioned.')
  console.log('organizationId:', result.value.id)
  console.log('name:', result.value.name)
  console.log('Next: set AUTHZ_BOOTSTRAP_ORGANIZATION_ID to this id and run npm run authz:bootstrap:dev.')
}

main()
  .catch((error) => {
    console.error('Provisioning failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
