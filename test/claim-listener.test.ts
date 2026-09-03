// The loopback listener is the one thing in this package that accepts a
// request from a browser. Three rules are pinned: only the web origin is
// answered, only this pairing's id is accepted, and one claim is taken.
import { describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { startClaimListener } from '../src/claim-listener.js';

const ORIGIN = 'https://zas.red';
const JSON_HEADERS = { 'content-type': 'application/json', origin: ORIGIN };

function send(port: number, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/claim', method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const claim = (pairingId: string, code: string) => JSON.stringify({ pairing_id: pairingId, code });

describe('claim listener', () => {
  it('answers the private-network preflight for the web origin only, on loopback only', async () => {
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode: async () => ({ status: 'claimed' }) });
    try {
      expect(listener.host).toBe('127.0.0.1');
      const ok = await send(listener.port, 'OPTIONS', {
        origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true',
      });
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(ok.headers['access-control-allow-methods']).toBe('POST');
      expect(ok.headers['access-control-allow-headers']).toBe('content-type');
      expect(ok.headers['access-control-allow-private-network']).toBe('true');
      const other = await send(listener.port, 'OPTIONS', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
      expect(other.status).toBe(403);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await listener.close();
    }
  });

  it('takes one claim from the web origin for its own pairing, relays the outcome, and refuses the rest', async () => {
    const onCode = vi.fn(async (code: string) =>
      (code === 'ABCDEFGH' ? { status: 'claimed' as const } : { error: 'claim_mismatch', status: 403 }));
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode });
    try {
      expect((await send(listener.port, 'POST', { ...JSON_HEADERS, origin: 'https://evil.example' }, claim('p1', 'ABCDEFGH'))).status).toBe(403);
      expect((await send(listener.port, 'POST', JSON_HEADERS, claim('p2', 'ABCDEFGH'))).status).toBe(400);
      expect((await send(listener.port, 'POST', { origin: ORIGIN, 'content-type': 'text/plain' }, 'ABCDEFGH')).status).toBe(400);
      expect((await send(listener.port, 'POST', JSON_HEADERS, 'not json')).status).toBe(400);
      expect(onCode).not.toHaveBeenCalled();

      const first = await send(listener.port, 'POST', JSON_HEADERS, claim('p1', 'ABCDEFGH'));
      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ status: 'claimed' });
      expect(first.headers['access-control-allow-origin']).toBe(ORIGIN);

      const second = await send(listener.port, 'POST', JSON_HEADERS, claim('p1', 'ABCDEFGH'));
      expect(second.status).toBe(409);
      expect(JSON.parse(second.body)).toEqual({ error: 'claim_taken' });
      expect(onCode).toHaveBeenCalledTimes(1);
      expect(onCode).toHaveBeenCalledWith('ABCDEFGH');
    } finally {
      await listener.close();
    }
  });

  it('relays a refusal with the status the server gave', async () => {
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode: async () => ({ error: 'pairing_expired', status: 410 }) });
    try {
      const answer = await send(listener.port, 'POST', JSON_HEADERS, claim('p1', 'ABCDEFGH'));
      expect(answer.status).toBe(410);
      expect(JSON.parse(answer.body)).toEqual({ error: 'pairing_expired' });
      expect((await send(listener.port, 'GET', { origin: ORIGIN })).status).toBe(404);
    } finally {
      await listener.close();
    }
  });

  it('stops answering once closed', async () => {
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode: async () => ({ status: 'claimed' }) });
    await listener.close();
    await expect(send(listener.port, 'POST', JSON_HEADERS, claim('p1', 'ABCDEFGH'))).rejects.toThrow();
  });

  it('rejects a JSON body of literal null without crashing', async () => {
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode: async () => ({ status: 'claimed' }) });
    try {
      const answer = await send(listener.port, 'POST', JSON_HEADERS, 'null');
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toEqual({ error: 'bad_request' });

      // Verify the listener is still working after the null body.
      const second = await send(listener.port, 'POST', JSON_HEADERS, claim('p1', 'ABCDEFGH'));
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toEqual({ status: 'claimed' });
    } finally {
      await listener.close();
    }
  });

  it('rejects an oversized JSON body over HTTP 400', async () => {
    const listener = await startClaimListener({ webOrigin: ORIGIN, pairingId: 'p1', onCode: async () => ({ status: 'claimed' }) });
    try {
      const bigBody = JSON.stringify({ pairing_id: 'p1', code: 'ABCDEFGH', pad: 'x'.repeat(2000) });
      const answer = await send(listener.port, 'POST', JSON_HEADERS, bigBody);
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toEqual({ error: 'bad_request' });
    } finally {
      await listener.close();
    }
  });
});
