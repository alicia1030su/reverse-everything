import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@reverse/contracts';
import { enumerateDevices, enumerateSerialPorts, type EnumerationResult, type SerialPort } from '@reverse/hardware';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function requireLocalHardware(request: FastifyRequest): void {
  if (process.env.RE_ALLOW_REMOTE === 'true' || !LOOPBACK.has(request.ip)) {
    throw new AppError('FORBIDDEN', 'Hardware enumeration is available only to the local desktop or loopback API', 403);
  }
}

export function registerHardwareRoutes(app: FastifyInstance): void {
  let pending: Promise<EnumerationResult> | undefined;
  let cached: { at: number; value: EnumerationResult } | undefined;
  const devices = (): Promise<EnumerationResult> => {
    if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = enumerateDevices().then(value => {
      cached = { at: Date.now(), value };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };

  app.get('/api/hardware/capabilities', async request => {
    requireLocalHardware(request);
    const result = await devices();
    return { platform: result.platform, status: result.status, capabilities: result.capabilities, limitations: result.limitations };
  });
  app.get('/api/hardware/doctor', async request => {
    requireLocalHardware(request);
    const result = await devices();
    return { platform: result.platform, status: result.status, deviceCount: result.devices.length, capabilities: result.capabilities, limitations: result.limitations, anomalies: result.anomalies, truncated: result.truncated };
  });
  app.get('/api/hardware/devices', async request => {
    requireLocalHardware(request);
    return devices();
  });
  app.get('/api/hardware/serial', async request => {
    requireLocalHardware(request);
    const ports: SerialPort[] = await enumerateSerialPorts();
    return { ports, opened: false, liveCapture: false, limitations: ['Serial ports are listed only; no port is opened and DTR/RTS are not changed'] };
  });
}
