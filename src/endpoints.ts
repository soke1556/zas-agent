import { ZasError } from './errors.js';

export interface Endpoints {
  api_base: string;
  token_base: string;
  oprf_base: string;
  firestore_project: string;
}

const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const refuse = (setting: string): never => { throw new ZasError('unsafe_endpoint', 0, setting); };

export function validateBase(value: string, setting: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return refuse(setting); }
  if (url.username || url.password || url.search || url.hash) return refuse(setting);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url) && process.env.ZAS_ALLOW_INSECURE_DEV === '1')) {
    return refuse(setting);
  }
  return url;
}

export function emulatorBase(setting: 'FIRESTORE_EMULATOR_HOST' | 'FIREBASE_AUTH_EMULATOR_HOST'): string | undefined {
  const host = process.env[setting];
  if (!host) return undefined;
  const url = validateBase(`http://${host}`, setting);
  if (!loopback(url) || url.pathname !== '/' || process.env.ZAS_ALLOW_INSECURE_DEV !== '1') return refuse(setting);
  return url.origin;
}

/** Emulator sessions are isolated from production at every credential source,
 * including profiles saved by older releases. A dev flag alone is not enough. */
export function validateEndpoints(endpoints: Endpoints): void {
  const bases = [
    validateBase(endpoints.api_base, 'api_base / ZAS_API_BASE'),
    validateBase(endpoints.token_base, 'token_base / ZAS_TOKEN_BASE'),
    validateBase(endpoints.oprf_base, 'oprf_base / ZAS_OPRF_BASE'),
  ];
  const auth = emulatorBase('FIREBASE_AUTH_EMULATOR_HOST');
  const firestore = emulatorBase('FIRESTORE_EMULATOR_HOST');
  if ((auth || firestore) && (!auth || !firestore || !/^demo-[a-z0-9-]+$/.test(endpoints.firestore_project) || !bases.every(loopback))) {
    refuse('Emulators require both loopback emulator hosts, loopback API/token/OPRF bases and a demo-* Firebase project');
  }
}
