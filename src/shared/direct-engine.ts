// The two ends of a directo transfer. Each engine owns one RTCPeerConnection
// and the data channel between them; everything it cannot decide alone comes
// in through injection — signaling as plain objects (the wiring in Main seals
// them with the channel key and posts them through the API; this file never
// sees a key), and the receiver's destination as a sink the caller builds.
// That keeps both engines runnable against stubs, with no browser at all.
//
// Shared between the web app and the agent: a Node process runs the sender
// unchanged once `RTCPeerConnection`, `RTCIceCandidate` and
// `RTCSessionDescription` exist as globals (node-datachannel's polyfill). The
// browser-only receiver sink lives in web/src/lib/direct.ts.
import {
  DIRECT_BUFFERED_HIGH,
  DIRECT_CHUNK_BYTES,
  DIRECT_CONNECT_TIMEOUT_MS,
  DIRECT_FILE_MAX_BYTES,
  DIRECT_RECEIVE_WINDOW_BYTES,
  DIRECT_SIGNAL_WAIT_MS,
  DIRECT_STALL_GRACE_MS,
} from './direct.js';
import { createSHA256 } from 'hash-wasm';
import {
  ABORT_FRAME,
  DONE_FRAME,
  encodeChunk,
  encodeCredit,
  encodeDone,
  directMetaOf,
  encodeMeta,
  parseFrame,
  type DirectMeta,
} from './direct-protocol.js';

export type DirectPhase = 'connecting' | 'flight' | 'done' | 'failed';
export type DirectPath = 'lan' | 'wan' | 'relay';

/** One signaling utterance, before sealing. `candidate: null` is the real
 *  end-of-candidates marker and travels like any other. */
export interface SignalMsg {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  /** Direct protocol and ICE generation. Absent is the deployed v1 peer. */
  protocol?: number;
  generation?: number;
}

/** STUN only — address discovery, never relay. When no direct route exists
 *  the transfer fails and the storage path takes over; that fallback is the
 *  reason this list needs no TURN entry to be dependable. */
export const DIRECT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

export interface DirectHandle {
  /** Feeds one unsealed signal from the other end. */
  accept(msg: SignalMsg): void;
  /** Tears the session down on purpose — Cortar/Cancelar. Tells the peer
   *  (best effort) and goes quiet; no phase callback fires, because the
   *  caller who cut is the caller being told. */
  close(): void;
}

/** What a session can say about itself once it ends — the raw material of
 *  the funnel. Counts and closed vocabulary only: candidate TYPES are kept,
 *  the addresses inside the candidates never leave the engine. Delivered to
 *  `onDiag` right before the terminal phase callback, so the phase handler
 *  can already read it. */
export interface DirectDiag {
  /** Why it failed — '' on success. Closed set: peer_silent, connect_timeout,
   *  ice_failed, disconnected, peer_closed, peer_abort, signaling,
   *  signal_send, protocol, sink, transfer, too_big. */
  reason: string;
  /** The thrown error's own message, when the failure came from an exception
   *  rather than a decision. `reason` has to stay a closed set — telemetry
   *  groups on it — so every real cause used to be discarded at the catch.
   *  This is that cause, trimmed: one `transfer` in a thousand is the disk
   *  filling up, and nothing in the closed set can say so. */
  detail?: string;
  /** Engine start to terminal phase, ms. */
  ms: number;
  /** Engine start to the data channel opening, ms; absent if it never did. */
  msConnect?: number;
  iceState: string;
  gatherState: string;
  hadRemoteDesc: boolean;
  /** Local candidates gathered, by type. srflx present + ice_failed is the
   *  needs-TURN signature. */
  localHost: number;
  localSrflx: number;
  localRelay: number;
  /** Remote candidates received through the signal bus, by type. */
  remoteHost: number;
  remoteSrflx: number;
  remoteRelay: number;
  /** TURN URL count supplied to RTCPeerConnection. This says whether relay
   *  credentials reached the engine without exposing the server URLs. */
  turnUrlsSupplied: number;
  /** TURN URL count retained in the peer connection's current configuration. */
  turnUrlsConfigured: number;
  /** The selected pair's candidate types, when a pair was ever selected. */
  pairLocal?: string;
  pairRemote?: string;
  /** Payload bytes actually moved before the session ended. */
  bytes: number;
  /** Mid-flight stalls the session rode out with an ICE restart. A completed
   *  transfer with restarts > 0 is a rebinding network survived, not a clean
   *  path. */
  restarts: number;
  /** The session as it happened, one short line per event, stamped with
   *  seconds since the engine started: the ICE server shapes it was given,
   *  every candidate by type and transport, the gathering and connection
   *  states, and the terminal verdict. The counts above say what was
   *  gathered; this says when, and in what order, which is the difference
   *  between "no reflexive candidate" and "no reflexive candidate yet".
   *  Same rule as the counts: types, transports and timings only — never an
   *  address, a port, a host name or a credential. Bounded at TRACE_MAX
   *  lines, so a long session cannot grow it without limit. */
  trace: string[];
}

/** The type inside a candidate line: `... typ host ...` → 'host'. */
function candType(candidate: RTCIceCandidateInit | null | undefined): string {
  const m = /\styp\s+(\S+)/.exec(candidate?.candidate ?? '');
  return m ? m[1] : 'other';
}

/** The transport inside a candidate line: field 3 of `candidate:<foundation>
 *  <component> <transport> ...`. A relay candidate always reads `udp` here —
 *  that is the leg between the peers, not the leg to the TURN server, which
 *  SDP never carries. `tcptype` is appended when present, because a passive
 *  TCP candidate and an active one behave differently. */
function candProto(candidate: RTCIceCandidateInit | null | undefined): string {
  const line = candidate?.candidate ?? '';
  // Three shapes reach here. A browser writes `candidate:<foundation> ...`;
  // node-datachannel prefixes the SDP attribute, `a=candidate:...`; and the
  // bare form with no prefix is legal on the wire too. All three are the same
  // line, so the prefix is optional rather than assumed.
  const m = /^(?:a=)?(?:candidate:)?\S+\s+\d+\s+(\S+)/.exec(line);
  const proto = m ? m[1].toLowerCase() : '?';
  const tcp = /\stcptype\s+(\S+)/.exec(line);
  return tcp ? `${proto}/${tcp[1]}` : proto;
}

/** How many lines a trace may hold. Gathering against six TURN URLs on a
 *  multi-homed machine is the busy case and stays well inside this. */
const TRACE_MAX = 200;

/** How much of a thrown error's message is kept. Long enough for a stack's
 *  first line, short enough that it cannot become the whole report. */
const DETAIL_MAX = 200;

/** A thrown value as one line. Errors give their message; anything else is
 *  stringified, because a rejection is not obliged to be an Error. */
function errText(e: unknown): string {
  const raw = e instanceof Error ? (e.message || e.name) : String(e);
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX)}…` : line;
}

/** Engine start per diag. Held beside the diag rather than inside it: the
 *  trace needs a clock, the diag's readers do not, and every call site that
 *  traces already has the diag in hand. */
const traceStart = new WeakMap<DirectDiag, number>();

/** Appends one trace line, stamped with seconds since the engine started.
 *  The cap is a hard stop with a marker, never a silent truncation. */
function traceAdd(diag: DirectDiag, line: string): void {
  if (diag.trace.length >= TRACE_MAX) return;
  if (diag.trace.length === TRACE_MAX - 1) {
    diag.trace.push('trace full');
    return;
  }
  const t0 = traceStart.get(diag);
  const at = t0 === undefined ? 0 : (Date.now() - t0) / 1000;
  diag.trace.push(`${at.toFixed(2)} ${line}`);
}

/** The ICE server list as shapes, for the trace: scheme and transport of
 *  every URL, counted. The host names are the relay operator's and the
 *  credentials are metered, so neither belongs in something a person pastes
 *  into a channel. `stun:x?transport=udp` and a bare `stun:x` are one shape. */
function iceShapes(servers: RTCIceServer[] | undefined): string {
  const seen = new Map<string, number>();
  for (const server of servers ?? []) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    for (const url of urls ?? []) {
      const scheme = /^(stuns?|turns?):/i.exec(url)?.[1]?.toLowerCase() ?? 'other';
      const transport = /[?&]transport=(\w+)/i.exec(url)?.[1]?.toLowerCase();
      const shape = transport ? `${scheme}/${transport}` : scheme;
      seen.set(shape, (seen.get(shape) ?? 0) + 1);
    }
  }
  const parts = [...seen].map(([shape, n]) => `${shape}x${n}`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** The diagnostic as lines a person reads, in the order that answers "what
 *  happened": the verdict, then the counts, then the session itself. One
 *  formatter for both ends, so a browser's block and an agent's block can be
 *  laid side by side without translating between them. The caller adds its
 *  own heading and indent — this knows the diag, not where it is printed. */
export function formatDirectDiagLines(d: DirectDiag): string[] {
  const connect = d.msConnect === undefined ? '-' : `${d.msConnect}ms`;
  const pair = d.pairLocal || d.pairRemote ? `${d.pairLocal || '?'}/${d.pairRemote || '?'}` : 'none';
  return [
    `ms=${d.ms} connect=${connect} bytes=${d.bytes} restarts=${d.restarts} pair=${pair}`,
    ...(d.detail === undefined ? [] : [`detail ${d.detail}`]),
    `local host=${d.localHost} srflx=${d.localSrflx} relay=${d.localRelay}`
      + `   remote host=${d.remoteHost} srflx=${d.remoteSrflx} relay=${d.remoteRelay}`,
    `turn supplied=${d.turnUrlsSupplied} configured=${d.turnUrlsConfigured}`
      + `   ice=${d.iceState} gather=${d.gatherState} remote_desc=${d.hadRemoteDesc}`,
    ...(d.trace ?? []),
  ];
}

function countCand(diag: DirectDiag, side: 'local' | 'remote', c: RTCIceCandidateInit | null | undefined): void {
  // A null candidate is the end-of-candidates marker, which is exactly the
  // event a stalled gathering never reaches. It counts for nothing and
  // matters more than most lines in the trace.
  if (!c) {
    traceAdd(diag, `${side} end-of-candidates`);
    return;
  }
  const t = candType(c);
  traceAdd(diag, `${side} ${t} ${candProto(c)}`);
  if (t === 'host') diag[side === 'local' ? 'localHost' : 'remoteHost']++;
  else if (t === 'srflx' || t === 'prflx') diag[side === 'local' ? 'localSrflx' : 'remoteSrflx']++;
  else if (t === 'relay') diag[side === 'local' ? 'localRelay' : 'remoteRelay']++;
}

function countTurnUrls(servers: RTCIceServer[] | undefined): number {
  let n = 0;
  for (const server of servers ?? []) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    for (const url of urls ?? []) {
      if (/^turns?:/i.test(url)) n++;
    }
    const legacy = (server as { url?: string }).url;
    if (typeof legacy === 'string' && /^turns?:/i.test(legacy)) n++;
  }
  return n;
}

/** The selected pair's candidate types, when the stats name one. */
function pairFromStats(stats: RTCStatsReport): { local: string; remote: string } | undefined {
  let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
  stats.forEach((s: Record<string, unknown>) => {
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
      pair = s as typeof pair;
    }
  });
  if (!pair?.localCandidateId || !pair.remoteCandidateId) return undefined;
  const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
  const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
  if (!local?.candidateType || !remote?.candidateType) return undefined;
  return { local: local.candidateType, remote: remote.candidateType };
}

/** The pair read as a path: both ends `host` means the bytes never left the
 *  local network; either end `relay` means they pass through the TURN server
 *  (still sealed — the relay forwards DTLS it cannot read). */
function pathOf(pair: { local: string; remote: string }): DirectPath {
  if (pair.local === 'relay' || pair.remote === 'relay') return 'relay';
  return pair.local === 'host' && pair.remote === 'host' ? 'lan' : 'wan';
}

/** Reads the connected pair out of a stats report. Undefined until a pair is
 *  selected. */
export function pathFromStats(stats: RTCStatsReport): DirectPath | undefined {
  const pair = pairFromStats(stats);
  if (!pair) return undefined;
  return pathOf(pair);
}

/** Whether this connection actually holds a remote description. A browser
 *  answers `null` before one is set; node-datachannel answers `{ sdp: '' }`,
 *  which is truthy. Reading the object alone made a receiver in Node take the
 *  very first offer for a stale ICE restart and drop it, so the sdp is what
 *  has to be read. */
function hasRemoteDescription(pc: { remoteDescription: { sdp?: string } | null }): boolean {
  return !!pc.remoteDescription?.sdp;
}

/** Everything the two engines share: phase discipline (terminal states are
 *  terminal, exactly like the offer doc's), the connect timeout, the
 *  disconnected grace, teardown, and the diag record the session narrates
 *  itself into. */
function session(
  ice: RTCIceServer[] | undefined,
  onPhase: (p: DirectPhase) => void,
  onDiag?: (d: DirectDiag) => void,
  iceTransportPolicy: RTCIceTransportPolicy = 'all',
) {
  const initialIce = ice ?? DIRECT_ICE;
  const pc = new RTCPeerConnection({
    iceServers: initialIce,
    iceTransportPolicy,
    // Gather before there is anything to gather for. A receiver whose peer
    // is an agent gets the whole remote candidate set at once — the agent
    // writes it and leaves — so checking starts in the same tick as the local
    // description, a pair comes up on the first candidate found, and
    // gathering is reported complete before any relay allocation returns.
    // Measured 2026-09-04: one host candidate, no relay, gathering done at
    // 240 ms, and when that pair died five seconds later there was nothing
    // to fall back to. The pool does the allocations up front, at construction,
    // so the relay candidates exist before the first check is ever sent.
    iceCandidatePoolSize: 1,
  });
  let phase: DirectPhase = 'connecting';
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stallState: 'idle' | 'grace' | 'restarting' = 'idle';
  const startedAt = Date.now();
  const diag: DirectDiag = {
    reason: '', ms: 0, iceState: '', gatherState: '', hadRemoteDesc: false,
    localHost: 0, localSrflx: 0, localRelay: 0,
    remoteHost: 0, remoteSrflx: 0, remoteRelay: 0,
    turnUrlsSupplied: countTurnUrls(initialIce), turnUrlsConfigured: 0,
    bytes: 0, restarts: 0, trace: [],
  };
  traceStart.set(diag, startedAt);
  traceAdd(diag, `ice servers ${iceShapes(initialIce)} policy=${iceTransportPolicy}`);
  pc.onicegatheringstatechange = () => {
    traceAdd(diag, `gather ${String((pc as { iceGatheringState?: string }).iceGatheringState ?? '')}`);
  };

  const cleanup = () => {
    clearTimeout(waitTimer);
    clearTimeout(connectTimer);
    clearTimeout(disconnectTimer);
    clearTimeout(restartTimer);
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    pc.close();
  };
  const setPhase = (p: DirectPhase) => {
    if (phase === 'done' || phase === 'failed') return;
    phase = p;
    if (p === 'done' || p === 'failed') {
      // The terminal snapshot, taken while the pc is still open. onDiag fires
      // before onPhase so the phase handler can already read the diag.
      diag.ms = Date.now() - startedAt;
      diag.iceState = String(pc.iceConnectionState ?? '');
      diag.gatherState = String((pc as { iceGatheringState?: string }).iceGatheringState ?? '');
      diag.hadRemoteDesc = hasRemoteDescription(pc);
      diag.turnUrlsConfigured = countTurnUrls(pc.getConfiguration().iceServers);
      traceAdd(diag, `${p}${diag.reason ? ` ${diag.reason}` : ''} ice=${diag.iceState} gather=${diag.gatherState}`);
      onDiag?.(diag);
      onPhase(p);
      cleanup();
      return;
    }
    onPhase(p);
  };
  const fail = (reason: string, cause?: unknown) => {
    if (phase === 'done' || phase === 'failed') return;
    // First reason wins: the cause, not the cascade it sets off.
    if (!diag.reason) diag.reason = reason;
    if (cause !== undefined && diag.detail === undefined) {
      diag.detail = errText(cause);
      traceAdd(diag, `detail ${diag.detail}`);
    }
    setPhase('failed');
  };

  // Two clocks, one after the other. Until the peer's first signal arrives
  // the wait is a human's — a backgrounded phone needs its person to bring
  // the tab back before it can speak — so it gets minutes. From the first
  // signal on, the wait is ICE's: STUN answers in the first seconds or
  // never, so a handshake still pending at fifteen is not going to finish.
  const waitTimer = setTimeout(() => fail('peer_silent'), DIRECT_SIGNAL_WAIT_MS);
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heard = false;
  const signaled = () => {
    if (heard) return;
    heard = true;
    clearTimeout(waitTimer);
    connectTimer = setTimeout(() => fail('connect_timeout'), DIRECT_CONNECT_TIMEOUT_MS);
  };

  // A path that dies mid-flight is not a dead transfer: the DTLS/SCTP
  // association under the data channel survives an ICE restart, so the
  // engine that owns the offer reopens the handshake and the file resumes
  // where it stopped. `onStall` is that engine's move; the other end sets a
  // no-op with a longer window, so the restarting side always gives up
  // first. Before the channel ever carried bytes there is nothing to
  // resume — those deaths keep their own reasons.
  let onStall: (() => void) | undefined;
  let stallWindowMs = DIRECT_CONNECT_TIMEOUT_MS;
  const stalled = () => {
    if (phase === 'done' || phase === 'failed') return;
    clearTimeout(disconnectTimer);
    if (stallState === 'restarting') return;
    if (diag.msConnect === undefined || !onStall) {
      fail('disconnected');
      return;
    }
    stallState = 'restarting';
    diag.restarts++;
    traceAdd(diag, 'ice restart');
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => fail('disconnected'), stallWindowMs);
    onStall();
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    traceAdd(diag, `ice ${String(s ?? '')}`);
    if (s === 'failed') {
      // Mid-flight, `failed` is a stall with the verdict already in; before
      // the channel ever opened it is the TURN-shaped hole in the funnel.
      if (diag.msConnect !== undefined && onStall) stalled();
      else fail('ice_failed');
    }
    // Wi-Fi hiccups produce `disconnected` and recover on their own; give
    // them the grace window before opening a fresh handshake.
    if (s === 'disconnected' && stallState === 'idle') {
      stallState = 'grace';
      disconnectTimer = setTimeout(stalled, DIRECT_STALL_GRACE_MS);
    }
    if (s === 'connected' || s === 'completed') {
      clearTimeout(disconnectTimer);
      clearTimeout(restartTimer);
      stallState = 'idle';
    }
  };

  return {
    pc,
    diag,
    setPhase,
    fail,
    cleanup,
    signaled,
    connected: () => {
      clearTimeout(waitTimer);
      clearTimeout(connectTimer);
      if (diag.msConnect === undefined) {
        diag.msConnect = Date.now() - startedAt;
        traceAdd(diag, 'channel open');
      }
    },
    isTerminal: () => phase === 'done' || phase === 'failed',
    setStall: (fn: () => void, windowMs: number) => {
      onStall = fn;
      stallWindowMs = windowMs;
    },
    setIceServers: (iceServers: RTCIceServer[]) => {
      diag.turnUrlsSupplied = countTurnUrls(iceServers);
      traceAdd(diag, `ice servers replaced ${iceShapes(iceServers)}`);
      pc.setConfiguration({ iceServers });
    },
  };
}

/** Wires outbound ICE and inbound signal application, with the one ordering
 *  hazard handled: candidates that arrive before the remote description are
 *  queued, never dropped and never applied early. */
function signalPlumbing(
  pc: RTCPeerConnection,
  send: (msg: SignalMsg) => Promise<void>,
  onSendError: () => void,
  diag: DirectDiag,
) {
  let localGeneration = 1;
  let remoteGeneration = 0;
  let remoteReady = false;
  const pendingByGeneration = new Map<number, (RTCIceCandidateInit | null)[]>();
  let pendingLegacy: (RTCIceCandidateInit | null)[] = [];
  pc.onicecandidate = (e) => {
    const c = e.candidate;
    countCand(diag, 'local', c as RTCIceCandidateInit | null);
    void send({
      kind: 'ice',
      candidate: c ? (c.toJSON ? c.toJSON() : c) : null,
      protocol: 2,
      generation: localGeneration,
    }).catch(onSendError);
  };
  const apply = (candidate: RTCIceCandidateInit | null) => {
    void pc.addIceCandidate((candidate ?? undefined) as RTCIceCandidateInit).catch(() => undefined);
  };
  // Counting happens only at the outer entry — flushIce replays through
  // `apply`, so a queued candidate is never counted twice.
  const applyIce = (
    candidate: RTCIceCandidateInit | null | undefined,
    generation?: number,
  ) => {
    countCand(diag, 'remote', candidate);
    const normalized = candidate ?? null;
    if (generation === undefined) {
      if (remoteReady) apply(normalized);
      else pendingLegacy.push(normalized);
      return;
    }
    if (generation < remoteGeneration) return;
    if (remoteReady && generation === remoteGeneration) {
      apply(normalized);
      return;
    }
    const queued = pendingByGeneration.get(generation) ?? [];
    queued.push(normalized);
    pendingByGeneration.set(generation, queued);
  };
  const expectRemoteGeneration = (generation: number) => {
    remoteGeneration = generation;
    remoteReady = false;
  };
  const remoteDescriptionSet = (generation: number) => {
    remoteGeneration = generation;
    remoteReady = true;
    const queued = pendingByGeneration.get(generation) ?? [];
    pendingByGeneration.delete(generation);
    const legacy = pendingLegacy;
    pendingLegacy = [];
    queued.forEach(apply);
    legacy.forEach(apply);
  };
  return {
    applyIce,
    expectRemoteGeneration,
    remoteDescriptionSet,
    setLocalGeneration: (generation: number) => void (localGeneration = generation),
  };
}

export interface SenderOpts {
  file: Blob;
  /** This device's name, shown on the receiving side. */
  label?: string;
  /** Only needed when `file` is a bare Blob without a name of its own. */
  name?: string;
  ice?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  refreshIce?: () => Promise<RTCIceServer[]>;
  send: (msg: SignalMsg) => Promise<void>;
  onPhase: (p: DirectPhase) => void;
  onProgress?: (sent: number, total: number) => void;
  onPath?: (p: DirectPath) => void;
  onDiag?: (d: DirectDiag) => void;
}

export function startSender(opts: SenderOpts): DirectHandle {
  const s = session(opts.ice, opts.onPhase, opts.onDiag, opts.iceTransportPolicy);
  opts.onPhase('connecting');
  const { pc } = s;
  const plumbing = signalPlumbing(pc, opts.send, () => s.fail('signal_send'), s.diag);
  let generation = 1;
  let peerProtocol = 1;
  // The rebinding handshake, when the path dies under a live transfer:
  // fresh candidates over the still-alive signal bus. The receiver answers
  // it like the first offer; the pump never notices.
  s.setStall(() => {
    void (async () => {
      generation++;
      plumbing.setLocalGeneration(generation);
      plumbing.expectRemoteGeneration(generation);
      if (opts.refreshIce) {
        const iceServers = await opts.refreshIce();
        s.setIceServers(iceServers);
      }
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await opts.send({ kind: 'offer', sdp: offer.sdp, protocol: 2, generation });
    })().catch((e: unknown) => s.fail('signaling', e));
  }, DIRECT_CONNECT_TIMEOUT_MS);

  const dc = pc.createDataChannel('zas-direct', { ordered: true });
  dc.binaryType = 'arraybuffer';
  // Resume well before empty: the reader refills while SCTP drains the rest,
  // so the wire never sits idle between pauses.
  dc.bufferedAmountLowThreshold = DIRECT_BUFFERED_HIGH / 8;

  const waitLow = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', done);
    });

  let persisted = 0;
  const creditWaiters: { target: number; resolve: () => void }[] = [];
  const wakeCredits = () => {
    for (let i = creditWaiters.length - 1; i >= 0; i--) {
      if (s.isTerminal() || persisted >= creditWaiters[i].target) {
        creditWaiters.splice(i, 1)[0].resolve();
      }
    }
  };
  const waitPersisted = (target: number) => {
    if (peerProtocol < 2 || persisted >= target || s.isTerminal()) return Promise.resolve();
    return new Promise<void>((resolve) => creditWaiters.push({ target, resolve }));
  };

  const pump = async () => {
    const meta: DirectMeta = {
      ...directMetaOf(opts.file, opts.name),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    };
    dc.send(encodeMeta(meta) as unknown as ArrayBuffer);
    const hasher = await createSHA256();
    // slice().arrayBuffer() rather than stream(): the same bounded window
    // everywhere a Blob exists, with none of ReadableStream's per-engine
    // moods. Only one window is ever in memory.
    let sent = 0;
    for (let off = 0; off < opts.file.size; off += DIRECT_RECEIVE_WINDOW_BYTES) {
      const window = new Uint8Array(
        await opts.file.slice(
          off,
          Math.min(off + DIRECT_RECEIVE_WINDOW_BYTES, opts.file.size),
        ).arrayBuffer(),
      );
      hasher.update(window);
      if (s.isTerminal()) return;
      for (let at = 0; at < window.length; at += DIRECT_CHUNK_BYTES - 1) {
        if (dc.bufferedAmount > DIRECT_BUFFERED_HIGH) await waitLow();
        if (s.isTerminal()) return;
        const slice = window.subarray(at, Math.min(at + DIRECT_CHUNK_BYTES - 1, window.length));
        dc.send(encodeChunk(slice) as unknown as ArrayBuffer);
        sent += slice.length;
        s.diag.bytes = sent;
        opts.onProgress?.(sent, opts.file.size);
      }
      await waitPersisted(sent);
      if (s.isTerminal()) return;
    }
    dc.send(encodeDone({ size: sent, sha256: hasher.digest() }) as unknown as ArrayBuffer);
  };

  dc.onopen = () => {
    s.connected();
    s.setPhase('flight');
    void pc
      .getStats()
      .then((stats) => {
        const pair = pairFromStats(stats);
        if (!pair) return;
        s.diag.pairLocal = pair.local;
        s.diag.pairRemote = pair.remote;
        opts.onPath?.(pathOf(pair));
      })
      .catch(() => undefined);
    void pump().catch((e: unknown) => s.fail('transfer', e));
  };
  dc.onmessage = (e) => {
    // The only thing a receiver says back: DONE once its sink has closed over
    // the last byte. That is the moment the file exists on the other side.
    try {
      const frame = parseFrame(e.data as ArrayBuffer);
      if (frame.type === 'done') s.setPhase('done');
      if (frame.type === 'abort') s.fail('peer_abort');
      if (frame.type === 'credit') {
        if (frame.received < persisted || frame.received > opts.file.size) throw new Error('bad_credit');
        persisted = frame.received;
        wakeCredits();
      }
    } catch {
      s.fail('protocol');
    }
  };
  // Only the receiver's DONE acknowledgement proves its sink closed. A socket
  // close after our DONE was merely queued is not evidence that the tail made
  // it to disk.
  dc.onclose = () => {
    wakeCredits();
    if (!s.isTerminal()) s.fail('peer_closed');
  };

  void (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    plumbing.setLocalGeneration(generation);
    plumbing.expectRemoteGeneration(generation);
    await opts.send({ kind: 'offer', sdp: offer.sdp, protocol: 2, generation });
  })().catch((e: unknown) => s.fail('signaling', e));

  return {
    accept: (msg) => {
      if (s.isTerminal()) return;
      s.signaled();
      if (msg.kind === 'answer' && pc.signalingState === 'have-local-offer') {
        const answerGeneration = msg.generation ?? generation;
        // Firestore listeners are not ordered. A delayed answer from the
        // previous negotiation must not satisfy the offer for this restart.
        if (msg.generation !== undefined && answerGeneration !== generation) return;
        peerProtocol = msg.protocol === 2 ? 2 : 1;
        plumbing.expectRemoteGeneration(answerGeneration);
        void pc
          .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          .then(() => plumbing.remoteDescriptionSet(answerGeneration))
          .catch((e: unknown) => s.fail('signaling', e));
      }
      if (msg.kind === 'ice') plumbing.applyIce(msg.candidate, msg.generation);
    },
    close: () => {
      if (!s.isTerminal() && dc.readyState === 'open') {
        try {
          dc.send(ABORT_FRAME as unknown as ArrayBuffer);
        } catch {
          /* the peer finds out from the channel closing instead */
        }
      }
      wakeCredits();
      s.cleanup();
    },
  };
}

/** Where received bytes go. Built by the caller — at claim time, while the
 *  user's click is still fresh enough to open a save-file picker. */
export interface Sink {
  write(bytes: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(): void;
}

export interface ReceiverOpts {
  ice?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  refreshIce?: () => Promise<RTCIceServer[]>;
  expectedMeta?: DirectMeta;
  send: (msg: SignalMsg) => Promise<void>;
  onPhase: (p: DirectPhase) => void;
  onProgress?: (got: number, total: number) => void;
  onMeta?: (meta: DirectMeta) => void;
  onPath?: (p: DirectPath) => void;
  onDiag?: (d: DirectDiag) => void;
  sink: (meta: DirectMeta) => Promise<Sink>;
}

export function startReceiver(opts: ReceiverOpts): DirectHandle {
  let sinkRef: Sink | null = null;
  // Every failure lets go of the sink before the caller hears about it: a
  // discarded partial beats a nearly-complete file sitting in downloads
  // looking whole. (Production grew a 4.2 GiB mp4 missing only its tail —
  // unopenable, indistinguishable from complete by size.)
  const s = session(
    opts.ice,
    (p) => {
      if (p === 'failed') {
        try {
          sinkRef?.abort?.();
        } catch {
          /* discarding is best-effort */
        }
        sinkRef = null;
      }
      opts.onPhase(p);
    },
    opts.onDiag,
    opts.iceTransportPolicy,
  );
  // Stalls are the sender's to repair (it owns the offer); this end only
  // has to outwait the repair, so it gets double the window.
  s.setStall(() => undefined, DIRECT_CONNECT_TIMEOUT_MS * 2);
  opts.onPhase('connecting');
  const { pc } = s;
  const plumbing = signalPlumbing(pc, opts.send, () => s.fail('signal_send'), s.diag);
  let protocol = 1;
  let generation = 1;

  let dc: RTCDataChannel | undefined;
  // Frames arrive faster than a disk writes. The chain keeps them ordered
  // behind the sink without holding more than the unwritten tail in memory.
  let pipeline: Promise<Sink> | null = null;
  let total = 0;
  let got = 0;
  let queued = 0;
  let nextCredit = DIRECT_RECEIVE_WINDOW_BYTES;
  let hasherPromise: ReturnType<typeof createSHA256> | null = null;
  let finished = false;

  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      s.connected();
      s.setPhase('flight');
      void pc
        .getStats()
        .then((stats) => {
          const pair = pairFromStats(stats);
          if (!pair) return;
          s.diag.pairLocal = pair.local;
          s.diag.pairRemote = pair.remote;
          opts.onPath?.(pathOf(pair));
        })
        .catch(() => undefined);
    };
    dc.onmessage = (e2) => {
      try {
        const frame = parseFrame(e2.data as ArrayBuffer);
        if (frame.type === 'meta') {
          // The cap holds even against a sender that skipped its own check —
          // and it holds here, before the sink opens, so no save picker ever
          // appears for a file the engine will not accept.
          if (
            pipeline ||
            !Number.isSafeInteger(frame.meta.size) || frame.meta.size < 0 ||
            frame.meta.size > DIRECT_FILE_MAX_BYTES ||
            typeof frame.meta.name !== 'string' || frame.meta.name.length === 0 ||
            typeof frame.meta.mime !== 'string'
          ) {
            try {
              dc?.send(ABORT_FRAME as unknown as ArrayBuffer);
            } catch {
              /* the channel closing tells the sender instead */
            }
            s.fail(frame.meta.size > DIRECT_FILE_MAX_BYTES ? 'too_big' : 'protocol');
            return;
          }
          // The name and the size are what the person agreed to when they
          // pressed Receive, so a frame that renames or resizes the file is a
          // different file and the transfer stops here. The type is not part
          // of that promise: it decides nothing the person can see, the sink
          // takes it from this frame anyway, and a sender built before
          // `directMetaOf` reads it from the path while sending the default.
          if (
            opts.expectedMeta &&
            (frame.meta.name !== opts.expectedMeta.name ||
              frame.meta.size !== opts.expectedMeta.size)
          ) {
            dc?.send(ABORT_FRAME as unknown as ArrayBuffer);
            s.fail('protocol');
            return;
          }
          total = frame.meta.size;
          hasherPromise = createSHA256();
          opts.onMeta?.(frame.meta);
          pipeline = opts.sink(frame.meta).then((sink) => {
            sinkRef = sink;
            return sink;
          });
          pipeline.catch((e: unknown) => s.fail('sink', e));
        } else if (frame.type === 'chunk') {
          if (!pipeline || finished) throw new Error('chunk_before_meta');
          queued += frame.payload.length;
          if (queued > total) throw new Error('too_many_bytes');
          pipeline = pipeline.then(async (sink) => {
            await sink.write(frame.payload);
            const hasher = await hasherPromise!;
            hasher.update(frame.payload);
            got += frame.payload.length;
            s.diag.bytes = got;
            opts.onProgress?.(got, total);
            if (protocol >= 2 && (got >= nextCredit || got === total)) {
              dc?.send(encodeCredit(got) as unknown as ArrayBuffer);
              while (nextCredit <= got) nextCredit += DIRECT_RECEIVE_WINDOW_BYTES;
            }
            return sink;
          });
          pipeline.catch((e: unknown) => s.fail('sink', e));
        } else if (frame.type === 'done') {
          if (!pipeline || finished) throw new Error('done_before_meta');
          finished = true;
          void pipeline
            .then(async (sink) => {
              if (got !== total || queued !== total) throw new Error('size_mismatch');
              const sha256 = (await hasherPromise!).digest();
              if (
                protocol >= 2 &&
                (!frame.digest || frame.digest.size !== got || frame.digest.sha256 !== sha256)
              ) throw new Error('digest_mismatch');
              await sink.close();
              // The ack: only after the sink has closed — "done" must mean
              // the file exists here, not that the last frame arrived.
              dc?.send(DONE_FRAME as unknown as ArrayBuffer);
              s.setPhase('done');
            })
            .catch((e: unknown) => s.fail('integrity', e));
        } else if (frame.type === 'abort') {
          // The failed phase lets go of the sink; nothing more to do here.
          s.fail('peer_abort');
        }
      } catch {
        s.fail('protocol');
      }
    };
    dc.onclose = () => {
      if (!s.isTerminal()) s.fail('peer_closed');
    };
  };

  return {
    accept: (msg) => {
      if (s.isTerminal()) return;
      s.signaled();
      // First offer, or a mid-flight ICE restart from a sender whose path
      // died — `stable` means the last exchange finished, so a fresh offer
      // is a renegotiation, not glare.
      if (msg.kind === 'offer' && (!hasRemoteDescription(pc) || pc.signalingState === 'stable')) {
        const isRestart = hasRemoteDescription(pc);
        const offerGeneration = msg.generation ?? (isRestart ? generation + 1 : 1);
        // An old offer can surface after a completed renegotiation because
        // the mailbox query intentionally has no ordering requirement.
        if (isRestart && msg.generation !== undefined && offerGeneration <= generation) return;
        generation = offerGeneration;
        protocol = msg.protocol === 2 ? 2 : 1;
        plumbing.expectRemoteGeneration(generation);
        plumbing.setLocalGeneration(generation);
        void (async () => {
          if (isRestart && opts.refreshIce) {
            const iceServers = await opts.refreshIce();
            s.setIceServers(iceServers);
          }
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          plumbing.remoteDescriptionSet(generation);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await opts.send({ kind: 'answer', sdp: answer.sdp, protocol: 2, generation });
        })().catch((e: unknown) => s.fail('signaling', e));
      }
      if (msg.kind === 'ice') plumbing.applyIce(msg.candidate, msg.generation);
    },
    close: () => {
      if (!s.isTerminal() && dc?.readyState === 'open') {
        try {
          dc.send(ABORT_FRAME as unknown as ArrayBuffer);
        } catch {
          /* the peer finds out from the channel closing instead */
        }
      }
      sinkRef?.abort?.();
      s.cleanup();
    },
  };
}
