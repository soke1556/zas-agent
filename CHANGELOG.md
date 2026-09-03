# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/soke1556/zas-agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/soke1556/zas-agent/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/soke1556/zas-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/soke1556/zas-agent/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/soke1556/zas-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/soke1556/zas-agent/releases/tag/v0.1.0
