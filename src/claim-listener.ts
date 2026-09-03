// The loopback half of a pairing. The page the owner approved on hands the
// claim code to this process over http://127.0.0.1:<port>, so the code never
// passes through anyone's hands. Three rules hold: only the web app's origin
// is answered (the browser enforces it on the way back, this side enforces
// it on the way in), only this pairing's id is accepted, and exactly one
// claim is taken — the answer the server gave is relayed to the page, and
// the next request meets a closed door. A hostile local page can spend that
// one attempt and nothing else; the person then types the code instead.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ClaimOutcome = { status: 'claimed' } | { error: string; status: number };

export interface ClaimListener {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export interface ClaimListenerOptions {
  /** The web app's origin, `https://zas.red` in production. The only origin answered. */
  webOrigin: string;
  pairingId: string;
  /** Claims the code against the server. Its answer is what the page sees. */
  onCode: (code: string) => Promise<ClaimOutcome>;
}

/** A claim body is under a hundred bytes; anything bigger is not one. */
const BODY_MAX = 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let resolved = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // On exceeding BODY_MAX, stop buffering but keep consuming the stream so
      // we can send a clean HTTP 400 instead of tearing down the socket. The
      // listener is on loopback and belongs to one process, so a drain cannot
      // be abused by anyone who could not already hold the socket.
      if (size > BODY_MAX) {
        if (!resolved) { resolved = true; resolve(null); }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!resolved) { resolved = true; resolve(Buffer.concat(chunks).toString('utf8')); }
    });
    req.on('error', () => {
      if (!resolved) { resolved = true; resolve(null); }
    });
  });
}

export async function startClaimListener(opts: ClaimListenerOptions): Promise<ClaimListener> {
  let taken = false;
  const server = createServer(async (req, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? '');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url !== '/claim') { json(404, { error: 'not_found' }); return; }

    if (req.method === 'OPTIONS') {
      // Chrome's private-network preflight: a public page asking a loopback
      // address must be told, in this exact header, that it may.
      if (origin !== opts.webOrigin) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '300',
        Vary: 'Origin',
      });
      res.end();
      return;
    }

    if (req.method !== 'POST') { json(404, { error: 'not_found' }); return; }
    if (origin !== opts.webOrigin) { json(403, { error: 'forbidden' }); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    // JSON only: a simple request (text/plain, no preflight) from any page is
    // refused before it can spend the one attempt.
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      json(400, { error: 'bad_request' }); return;
    }
    const raw = await readBody(req);
    let body: { pairing_id?: unknown; code?: unknown } = {};
    try {
      body = raw === null ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      body = {};
    }
    // Validate that the parsed body is actually an object (not null, which
    // JSON.parse can return for the literal string "null").
    if (typeof body !== 'object' || body === null || body.pairing_id !== opts.pairingId || typeof body.code !== 'string') { json(400, { error: 'bad_request' }); return; }
    if (taken) { json(409, { error: 'claim_taken' }); return; }
    taken = true;
    const outcome = await opts.onCode(body.code);
    if ('error' in outcome) json(outcome.status, { error: outcome.error });
    else json(200, { status: 'claimed' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 is "any free port"; 127.0.0.1 is the whole reachable world.
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return {
    host: address.address,
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
