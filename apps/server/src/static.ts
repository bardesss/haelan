import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

export function registerStatic(app: FastifyInstance, webRoot: string): void {
  void app.register(fastifyStatic, { root: webRoot, wildcard: false })

  // Client routed paths such as /setup/google have no file behind them, so anything that is
  // not an API route and not a real file gets the shell and the router sorts it out.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/oauth/')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.sendFile('index.html')
  })
}
