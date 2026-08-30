import 'dotenv/config'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '../database/prisma.ts'

const baseURL = process.env.BETTER_AUTH_URL
const trustedOrigin = process.env.BETTER_AUTH_TRUSTED_ORIGIN
const secret = process.env.BETTER_AUTH_SECRET

if (!baseURL || !trustedOrigin || !secret) {
  throw new Error('Better Auth environment is incomplete')
}

export const auth = betterAuth({
  appName: 'SBN Billing',
  baseURL,
  basePath: '/api/auth',
  secret,
  trustedOrigins: [trustedOrigin],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.AUTH_ALLOW_SIGNUP !== 'true',
    autoSignIn: false,
    requireEmailVerification: false,
  },
  advanced: {
    database: {
      generateId: 'uuid',
    },
  },
})
