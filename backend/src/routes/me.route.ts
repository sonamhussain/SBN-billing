import { Router } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../shared/auth/auth.ts'
import { sendApiError } from '../shared/errors/error-response.ts'

const meRouter = Router()

meRouter.get('/me', async (req, res) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!session) {
    sendApiError(res, 401, 'UNAUTHENTICATED', 'sign in required')
    return
  }

  res.status(200).json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    },
  })
})

export default meRouter
