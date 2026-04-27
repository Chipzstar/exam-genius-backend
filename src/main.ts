import Fastify from 'fastify';
import cors from '@fastify/cors';
import { app } from './app/app';
import { serverRoutes } from './app/modules/server-routes';
import { scheduleStaleMarkingRecovery } from './app/modules/answer/marking.service';
import fastifyEnv from '@fastify/env';

/** Bind broadly in deploy targets; Node does not set NODE_ENV — Railway may not either. */
const listenOnAllInterfaces =
	process.env.NODE_ENV === 'production' ||
	process.env.DOPPLER_ENVIRONMENT === 'prd' ||
	Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
const host = listenOnAllInterfaces ? '0.0.0.0' : 'localhost';
const port = Number(process.env.PORT);

const schema = {
  type: 'object',
  required: ['OPENAI_API_KEY', 'BACKEND_SHARED_SECRET'],
  properties: {
    OPENAI_API_KEY: {
      type: 'string'
    },
    BACKEND_SHARED_SECRET: {
      type: 'string'
    }
  }
}

const options = {
  confKey: 'config',
  dotenv: true,
  schema,
  data: process.env
}

// Instantiate Fastify with some config
const server = Fastify({
  logger: true
});

server.register(fastifyEnv, options)
server.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
})

// Register your application as a normal plugin.
server.register(app);
scheduleStaleMarkingRecovery(err => server.log.error(err));

server.get("/healthcheck", async function () {
  return { status: "OK" };
})

server.register(serverRoutes, { prefix: '/server' })

// Start listening.
server.listen({ port, host }, err => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  } else {
    console.log(`[ ready ] ${process.env.NODE_ENV === "production" ? "https://" : "http://"}${host}:${port}`);
  }
});
