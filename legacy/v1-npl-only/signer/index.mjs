#!/usr/bin/env node
import { safeServiceErrorCode, startOrderSignerService } from './service.mjs';

function writeEvent(event) {
  const stream = event.level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

let service;
try {
  service = await startOrderSignerService({ log: writeEvent });
} catch (error) {
  writeEvent({
    level: 'error',
    event: 'order_signer_startup_failed',
    code: safeServiceErrorCode(error)
  });
  process.exitCode = 1;
}

if (service) {
  writeEvent({
    level: 'info',
    event: 'order_signer_ready',
    host: service.host,
    port: service.port,
    signer: service.signerAddress
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeEvent({ level: 'info', event: 'order_signer_shutdown_started', signal });
    try {
      await service.close();
      writeEvent({ level: 'info', event: 'order_signer_stopped' });
    } catch {
      writeEvent({
        level: 'error',
        event: 'order_signer_shutdown_failed',
        code: 'ORDER_SIGNER_SHUTDOWN_FAILED'
      });
      process.exitCode = 1;
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  };
  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
}
