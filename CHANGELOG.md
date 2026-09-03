# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/soke1556/zas-agent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/soke1556/zas-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/soke1556/zas-agent/releases/tag/v0.1.0
