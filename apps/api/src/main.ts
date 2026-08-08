import { composeApplication } from './composition.js';
import { ConfigurationError, loadEnvironment } from './config/environment.js';

/**
 * Process entry point.
 *
 * Three things happen in order, and each refuses to proceed if the one before
 * it did not hold: configuration is validated, the database is checked, then
 * the port is opened. A server that listens before confirming it can reach a
 * correctly-migrated database is a server that answers requests with errors —
 * and, worse, one an orchestrator considers healthy.
 */
async function main(): Promise<void> {
  let environment;
  try {
    environment = loadEnvironment();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      // Written to stderr rather than the logger: the logger is configured from
      // the configuration that just failed to load.
      console.error(error.message);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const { server, shutdown } = await composeApplication(environment);

  const stop = (signal: NodeJS.Signals): void => {
    server.log.info({ signal }, 'Shutting down.');
    void shutdown().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        server.log.error({ err: error }, 'Shutdown did not complete cleanly.');
        process.exitCode = 1;
      },
    );
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    await server.listen({ host: environment.HOST, port: environment.PORT });
  } catch (error: unknown) {
    server.log.fatal({ err: error }, 'The server could not start.');
    await shutdown();
    process.exitCode = 1;
  }
}

await main();
