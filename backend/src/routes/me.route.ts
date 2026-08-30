import { Router } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../shared/auth/auth.ts'

const meRouter = Router()

meRouter.get('/me', async (req, res) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!session) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'sign in required' },
    })
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
