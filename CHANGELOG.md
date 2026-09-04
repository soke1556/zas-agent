# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.3] - 2026-09-04

### Fixed

- The selected candidate pair is read from the transport, which names its
  own pair on every engine. A transfer that connected and carried its whole
  file could report `pair=none`, because the browser at the other end does
  not mark a pair `nominated` on the controlled side. The empty field was
  read as a missing pair and sent two rounds of diagnosis after a
  connection that had been there all along.
- A peer connection state of `failed` has to hold before the engine acts on
  it. Chrome reports `failed` while it is still gathering and returns to
  `connecting` in the same millisecond; acting on the first one killed a
  receiver at 0.88 s with pairs still waiting to be tried. The settle window
  is shorter than the ICE grace, so a connection that really is dead still
  gives up sooner than it did before.

### Added

- The trace counts candidate pairs by check state just before the verdict:
  `checks failed=24 in-progress=4`, or `checks none`. No pair selected could
  not tell a run that formed no pairs from one that formed pairs and lost
  every check, and those are different faults.
- A candidate the peer refuses is traced as `ice apply rejected <type>
  <ErrorName>`. The rejection used to be swallowed, so a refused candidate
  looked exactly like one the network lost.

## [0.6.2] - 2026-09-04

### Added

- The trace records the peer connection state, not only the ICE state.
  ICE `connected` means a candidate pair answered; the peer connection
  reaches `connected` only once DTLS completes. A session that holds an ICE
  path and sends nothing over it used to look the same as one that never
  found a path at all.
- A failure that had a working ICE pair is now `channel_never_opened`, not
  `connect_timeout`. Same clock, different fault: one is the candidate hunt,
  the other is the handshake above it.
- The verdict line carries the peer connection state and the data channel's
  own state, so a stalled DTLS handshake and a stalled SCTP association can
  be told apart from one line.
- The selected candidate pair is read when ICE connects, not only when the
  data channel opens. A run that connected and then went quiet reported
  `pair=none` and looked as if it had never selected one.
- `onicecandidateerror` is traced, by URL shape and error code only. A
  gather that ends with no relay candidate now says whether the allocation
  was refused or never answered.

## [0.6.1] - 2026-09-04

### Added

- A Directo run now answers with the engine's own account of itself, not
  only with one word. `zas_send_direct`, `zas_receive_direct` and `zas_jobs`
  carry the candidate counts by type for both ends, the ICE and gathering
  states, how many TURN URLs were supplied against how many the connection
  kept, the selected pair, the restarts, and a timestamped trace of the
  session: every candidate as it arrived, the state changes, and the verdict.
  Types, transports and timings only — never an address, a port, a host name
  or a credential. A run that fails on a machine you are not sitting at can
  now be diagnosed from the tool result.
- The thrown error behind a failure is kept as `detail`. The reason stays a
  closed word for grouping; `detail` is the sentence the exception carried,
  which every failure used to discard at the catch.

### Fixed

- The receiver pre-gathers a candidate pool. An agent hands its whole
  candidate set over at once, so the far end could start checking before its
  own relay candidates existed, connect on the first pair it found, and be
  left with nothing when that pair died seconds later.
- The transport of a candidate is read whichever way the peer wrote the line.
  This package prefixes the SDP attribute, so its candidates used to be
  reported with an unknown transport.

## [0.6.0] - 2026-09-03

### Added

- Usage reporting, so a defect like 0.5.0's — a release that could not
  receive a file at all — is visible without somebody writing in. One report
  after each tool call: the tool, whether it worked, the closed error code
  when it did not, a duration bucket and the version. Never a file name, a
  path, a channel name, a message or a stack. It goes to Zas, not to an
  analytics service: this package holds no analytics token and opens no
  connection to a third party.
- `zas-agent telemetry [on|off]`, `ZAS_AGENT_TELEMETRY` and `DO_NOT_TRACK`.
  Reporting is on by default; `pair` prints what it collects before it opens
  a browser, the first `serve` on a machine prints it once, and `zas_status`
  always says which way it is set. The choice lives in
  `~/.zas/agent/settings.json` and survives pairing again.

## [0.5.1] - 2026-09-03

### Fixed

- `zas_receive_direct` could not connect. The WebRTC engine in Node reports
  an empty description object where a browser reports none, and the
  receiver read that as a stale connection restart, so it dropped the very
  first offer: it never answered, and both ends waited out the thirty
  second clock. 0.5.0 could not receive a file at all. It can now.

## [0.5.0] - 2026-09-03

### Added

- `zas_receive_direct` receives a file the owner sends through Directo,
  straight onto this machine. It waits for the offer, takes it, and writes
  the file to disk; nothing is stored anywhere. Receiving is reading, so it
  needs a grant with `read`, and the channel has to be in Directo mode. The
  call returns the result, or a job id after a minute; `zas_jobs` follows the
  phases `waiting`, `connecting`, `flight`, `finishing`.
- `zas_receive_direct_fallback` finishes a receive that failed in flight,
  when the sender chose reliable delivery for it: the encrypted copy is
  downloaded and decrypted onto the same destination.
- New error codes: `no_offer` and `offer_taken`.

### Changed

- The agent claims an offer only inside a tool call. It never watches a
  channel: an exchange takes two devices and the first claim wins, so a
  watcher would take files meant for the owner's own phone.
- A received file never overwrites an existing one. It is written 0600
  through a temporary name and renamed only once the transfer is verified,
  so a run that breaks leaves nothing that reads as complete. The answered
  `path` is where the bytes actually went.
- `zas_status` says `receive (Directo)` where it said `read` for a channel
  in Directo mode: such a channel stores nothing, so there is no list of
  items behind the grant, only live offers to take.

## [0.4.0] - 2026-09-03

### Added

- `zas_send_direct` sends a file through Directo: a live, device-to-device
  transfer into a channel in Directo mode. Nothing is stored. The agent
  offers, the owner presses Receive on another device within ten minutes,
  and the bytes travel encrypted over WebRTC. The call returns the result,
  or a job id after a minute; `zas_jobs` follows the phases `offer`,
  `connecting`, `flight`, `finishing`.
- `zas_send_direct_fallback` delivers the file of a Directo send that
  failed in flight through reliable delivery: encrypted on this machine,
  stored in Cloudflare R2 for up to 24 hours, off the owner's quota. It is
  the owner's choice; the tool description tells the model to ask.
- A native dependency: `node-datachannel`, WebRTC for Node. npm installs a
  prebuilt binary; the module loads the first time `zas_send_direct` runs,
  and a machine where it cannot load answers `webrtc_unavailable`.
- New error codes: `not_claimed`, `direct_cancelled`, `direct_failed`,
  `direct_not_failed`, `file_changed`, `webrtc_unavailable`,
  `fallback_unavailable`.

### Changed

- `zas_status` says `send (Directo)` for a channel in Directo mode, where it
  said nothing. `zas_send_file` still refuses such a channel.

## [0.3.0] - 2026-09-03

### Added

- Pairing again in a profile that is already paired replaces the agent
  instead of adding a second one. The terminal opens the pairing as the old
  agent, the approval page says which agent it replaces and fills in its
  name and channels, and the old agent is revoked in the same step that
  creates the new one. If the server no longer accepts the old agent, `pair`
  says so and creates a new agent.

### Changed

- The help text, the tool descriptions and the README say "this agent" where
  they said "this machine": a pairing is one profile's key pair, and one
  machine can hold several.

## [0.2.1] - 2026-09-03

### Fixed

- The `claude mcp add` and `codex mcp add` lines the terminal prints after
  pairing quote the `--` separator. In PowerShell the npm-installed `claude`
  and `codex` commands are script shims, and PowerShell kept a bare `--` for
  itself, so `claude mcp add` refused `-y` as an unknown option.

## [0.2.0] - 2026-09-03

### Changed

- Pairing no longer prints a code to type. The terminal listens on
  `127.0.0.1`, the approval page hands it a one-time claim code, and the
  agent is created only when the terminal claims. A page that cannot reach
  the terminal shows the code, and the terminal asks for it. `pair` opens
  the browser; `--no-open` and `ZAS_NO_OPEN=1` keep it closed.
- `zas_pair` takes an optional `code` for the case where the page shows one.
- Older servers are not supported by this release: the claim route is
  required. Older CLIs keep working against the server.

## [0.1.1] - 2026-09-02

### Changed

- Every line the agent prints and every tool result is in English. The pairing
  prompt, the status report and the error sentences were in Spanish.
- The README opens with what Zas is. The README, the package keywords and the
  registry entry no longer call the design end-to-end encryption: the
  product's own privacy page does not, because a separate service derives
  account keys.

## [0.1.0] - 2026-09-02

### Added

- First release.
- Pairing: the agent mints its own key pair on the machine and proves it holds
  the private half by signing a P-256 challenge; the owner approves it from the
  web app and compares a fingerprint before they do.
- `zas_send_file` and `zas_send_note`: send a file or a note into a granted
  channel, end-to-end encrypted on this machine.
- `zas_list_items` and `zas_get_item`: list a channel's recent items and fetch
  one, where the grant includes reading.
- Per-channel grants: the agent holds one channel key per granted channel and
  no key for any other, and the owner can add or drop a channel at any time.
- `--profile`, so one machine can run a Claude Code agent and a Codex agent as
  two separate identities that cannot read each other's keys.
- Install snippets for Claude Code and Codex, printed by `zas-agent pair`.

[Unreleased]: https://github.com/soke1556/zas-agent/compare/v0.6.3...HEAD
[0.6.3]: https://github.com/soke1556/zas-agent/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/soke1556/zas-agent/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/soke1556/zas-agent/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/soke1556/zas-agent/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/soke1556/zas-agent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/soke1556/zas-agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/soke1556/zas-agent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/soke1556/zas-agent/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/soke1556/zas-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/soke1556/zas-agent/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/soke1556/zas-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/soke1556/zas-agent/releases/tag/v0.1.0
