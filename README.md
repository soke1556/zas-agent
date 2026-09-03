# zas-agent

An MCP server that lets a coding agent — Claude Code, Codex, or anything that
speaks MCP — send files and notes into your [Zas](https://zas.red) channels, and
read items back out of them.

[![npm](https://img.shields.io/npm/v/zas-agent)](https://www.npmjs.com/package/zas-agent)
[![CI](https://github.com/soke1556/zas-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/soke1556/zas-agent/actions/workflows/ci.yml)
[![CodeQL](https://github.com/soke1556/zas-agent/actions/workflows/codeql.yml/badge.svg)](https://github.com/soke1556/zas-agent/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/soke1556/zas-agent/badge)](https://scorecard.dev/viewer/?uri=github.com/soke1556/zas-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What is Zas

[Zas](https://zas.red) moves things between your devices and the people you
choose: files, photos, text, code. You put something into a channel on one
device and use it on another. Whatever you do not pin leaves on its own after a
few days, so there is nothing to tidy up later. Everything is encrypted on the
device before it is uploaded: the database and the object storage receive
encrypted bytes, not filenames, content or previews.

This package is the piece that lets a coding agent use your channels the way
your other devices do, under an identity of its own that you approve, that you
scope to the channels you choose, and that you can revoke.

## What it does

Your coding agent gets seven tools. It can send a file or a note into a channel
you picked, list what is in that channel, and pull one item back onto disk.
Everything it sends is encrypted on your machine before it leaves, lands in your
account, and is marked in the channel as sent by that agent. The agent has an
identity of its own and never holds your account key: pairing mints a key pair
here, you approve it from the web app, and from then on it signs a challenge to
get a short-lived session.

## Install

Pair the machine first, then hand the command to your harness.

**Pair**

```
npx -y zas-agent pair --profile claude-code
```

**Claude Code**

```
claude mcp add zas -- npx -y zas-agent --profile claude-code
```

**Codex**

```
codex mcp add zas -- npx -y zas-agent --profile codex
```

Codex by hand, if you would rather edit `~/.codex/config.toml`:

```toml
[mcp_servers.zas]
command = "npx"
args = ["-y", "zas-agent", "--profile", "codex"]
```

### What pairing does

`zas-agent pair` mints the key pair, registers the public halves, opens the
approval page in your browser, and waits. The terminal shows:

```
Open this page signed in to your Zas account:
  https://zas.red/agents/pair?p=...#port=53211
Fingerprint: 1a2b 3c4d 5e6f 7a8b
Waiting for approval… (expires in 10 minutes)
```

Signed in, name the agent and tick the channels it may use — sending is the
default, reading is a separate switch — and approve. Approval creates
nothing by itself: the page hands a one-time claim code to this terminal
over `127.0.0.1` (the port in the link), and the agent exists only once the
terminal claims with that code and the secret it holds. A link that reached
somebody else is approved on their machine, where nothing listens, and
expires with nothing created.

If the browser cannot reach the terminal — the link was opened on a phone,
or the browser refused the local connection — the page shows the code and
the terminal asks for it. Type it there and nowhere else: with that code,
another terminal that started a pairing could claim it. Pass `--no-open` or
set `ZAS_NO_OPEN=1` to keep the browser closed; the link is printed either
way. The pairing is good for ten minutes before approval and five after;
past that, run the command again.

You can also start the flow from the coding agent with the `zas_pair` tool:
the first call hands back the URL, a later call says whether the approval
landed, and if the page shows a code, a call with `code` claims with it.

## Why you can trust it

Every line here is a fact. The ones about this package you can check in this
repository. Where a property is enforced by the Zas server, which is not open
source, the sentence says so.

- **The agent has an identity of its own.** `zas-agent pair` generates two key
  pairs on your machine — X25519 to receive channel keys, P-256 to sign
  sign-ins — and the private halves never leave it. The agent never holds your
  account key, and the key-derivation service refuses account-key derivation to
  an agent *(server-side)*.
- **You approve it, and you choose the channels.** Pairing never
  auto-approves. The approval page shows the harness, the host and the key
  fingerprint, and nothing exists until the terminal that started the
  pairing claims it with a code only the approving page received
  *(server-side)*. A pairing link sent to you by someone else creates
  nothing on your account.
- **It holds one key per granted channel, and no key for any other.** Each
  grant carries that channel's key sealed to the agent's X25519 public key. A
  channel you did not grant has no key here to decrypt with, and the server
  checks the live grant on every request *(server-side)*.
- **No password and no API key.** Signing in is a signed challenge traded for a
  one-hour token. There is no password, no API key and no refresh token on
  disk: the agent re-signs from its P-256 key when the token ages out.
- **Everything it sends is visible as its work.** Every item carries the `>_`
  agent mark and the agent's name, in the channel, on every device you read Zas
  from.
- **You can revoke it at any time.** Settings → Agents → the agent → Revoke.
  The session stops, its refresh tokens are revoked *(server-side)*, and the
  next tool call answers "the owner revoked this agent". What it already sent
  stays where it is. You can also drop a single channel and keep the rest.
- **Content is encrypted on your machine before it leaves, the same way the
  app does it.** The
  chunking, the manifest and the envelope formats under `src/shared/` are the
  same modules the Zas web app ships. The server stores ciphertext and never
  sees a channel key, a channel name or item plaintext *(server-side)*.
- **The source is here, and the releases are built from it.** Every npm release
  is published by the `release.yml` workflow in this repository, with npm
  provenance, so the tarball on npm can be traced back to a commit and a
  workflow run.

## What it cannot do

The package refuses some of these on its own, before a request is made. The
ones marked *(server-side)* are enforced by the Zas server.

- **No channel you did not grant.** Not by name, not by id.
- **No shared channel you merely joined, and no workspace channel.** Grants
  exist only on channels your account owns and that no organization manages
  *(server-side)*.
- **No reading unless the grant says so.** `read` is a separate switch from
  `send`; without it, `zas_list_items` and `zas_get_item` are refused.
- **No sending into a view-only channel, and none into a channel in Directo
  mode.** Both are refused before a byte is uploaded.
- **Nothing outside its allowlist.** The API refuses an agent on every route
  that is not on a short, explicit list, and Firestore rules refuse it your
  account document, your devices, and any channel without an active read grant
  *(server-side)*.
- **Rate limited by the server**, on its own buckets, with the key-derivation
  budget charged to your account so ten agents are not ten times your own
  allowance *(server-side)*.
- **As many agents as your plan or your organization allows** *(server-side)*.
- **Files up to 5 GiB**, and in practice less: the agent reads a file into
  memory to hash it, so the machine's memory is the real ceiling.

### The error vocabulary

The agent answers in a closed set of codes. Anything a server route says that
is not in this set collapses to `upload_failed` or `network`, so no raw server
string ever reaches a terminal.

| Code | What it means |
| --- | --- |
| `not_paired` | This machine is not paired yet. |
| `identity_corrupt` | The identity file on disk is damaged. |
| `agent_revoked` | The owner revoked this agent. |
| `agent_forbidden` | Only the account owner can do that. |
| `grant_missing` | This agent has no access to that channel. |
| `send_forbidden` | This agent cannot send to that channel. |
| `read_forbidden` | This agent cannot read that channel. |
| `direct_mode` | That channel is in Directo mode. |
| `not_direct_mode` | That channel is not in Directo mode. |
| `key_stale` | The channel key changed; the owner refreshes it by opening Zas. |
| `quota_exceeded` | The account reached its storage limit. |
| `rate_limited` | Too many sends in a row. |
| `file_too_big` | The file is over the plan limit. |
| `duplicate` | That item is already in the channel. |
| `not_found` | That item is not in the channel. |
| `invalid_cap` | That file is no longer available. |
| `write_failed` | The download destination could not be written. |
| `pairing_expired` | The pairing expired; pair again. |
| `pairing_cancelled` | The owner cancelled the pairing. |
| `feature_disabled` | Agents are not enabled for this account yet. |
| `upload_failed` | The upload failed. |
| `oprf_failed` | Zas did not answer correctly while preparing the file. |
| `network` | Zas cannot be reached. |
| `sign_in_failed` | Zas did not accept this agent session. |
| `bad_signature` | Zas rejected this agent's signature; pair it again. |
| `missing_token` | The session token is missing; pair the agent again. |
| `internal` | Something failed inside the agent. |

Every code comes back as one sentence in English, never as a
stack trace.

## Tools

| Tool | What it does |
| --- | --- |
| `zas_status` | Says whether this machine is paired with a Zas account, and lists the owner's channels this agent may send to or read from. |
| `zas_pair` | Pairs this machine with a Zas account. The first call returns a URL for the owner to open; a later call says whether they approved. If the page shows a code, a call with `code` claims with it. |
| `zas_send_file` | Sends a file from this machine into one of the owner's channels. Returns the item id, or a job id when the upload takes longer than a minute. |
| `zas_send_note` | Sends a note — plain text, or a code snippet with its language — into one of the owner's channels. |
| `zas_list_items` | Lists the most recent items in one of the owner's channels. Needs a grant that includes reading. |
| `zas_get_item` | Fetches one item. A note comes back as text; a file is written to disk. It never overwrites, so the path it answers with can differ from the one you asked for. |
| `zas_jobs` | Lists the sends this server started, newest first, with the phase each one reached — and where a `job_id` from a long send is redeemed. |

`channel` takes a channel name or a channel id. A name has to match exactly one
of the channels you granted; with exactly one grant, `zas_send_file` and
`zas_send_note` can leave it out.

Two things worth knowing before you point a model at your account:

- `zas_send_file` sends any file this process can read — `~/.ssh/id_rsa` and a
  `.env` included. Confirm with the owner before sending secrets, keys or
  credentials. Its tool description says so, so the model reads it too.
- `zas_get_item` writes a new file under `dest`, or under the system temp
  directory when you leave `dest` out. It never overwrites an existing file: a
  name that is taken gets a suffix, and the path it answers with is the one it
  actually wrote.

Everything either tool touches lands inside your own account and your own
machine. Revoking the agent stops both.

## Data on disk

One directory per profile, so one machine can hold a Claude Code agent and a
Codex agent side by side without either reading the other's keys:

| OS | Path |
| --- | --- |
| macOS, Linux | `~/.zas/agent/<profile>/` |
| Windows | `%USERPROFILE%\.zas\agent\<profile>\` |

Four files, all written through a temporary file and renamed into place, so a
crash mid-write cannot leave half a file behind:

- `identity.json` — the agent uid, the owner uid, the name, and the two key
  pairs. Back it up like a private key, or delete it and pair again.
- `pending.json` — a pairing that has not been claimed yet. Removed on
  completion, and on a pairing that expired or was cancelled.
- `grants.json` — a one-minute cache of `GET /v1/agents/me`: which channels,
  and the sealed key for each. The channel name stays encrypted here.
  Disposable.
- `fingerprints.json` — hashes of what an identical send produced in the last
  ten minutes, so a retried tool call answers without touching the network. It
  stores hashes, never a title or a note's first line. Disposable.

On macOS and Linux the directory is created `0700` and every file `0600`. On
Windows those bits have no effect: the files carry the permissions of the user
profile they live in, and the package does not try to set any others.

Deleting the directory makes this machine forget the agent. It does not revoke
anything: the account side is closed from the web app, under
Settings → Agents → Revoke.

## Configuration

| Setting | Default | What it changes |
| --- | --- | --- |
| `--profile <name>` | `claude-code` | Which identity directory this process uses. Letters, digits, `.`, `_` and `-`, up to 64, and it may not start with a dot. |
| `ZAS_AGENT_HOME` | `~/.zas/agent` | Where the profile directories live. |
| `ZAS_WEB_BASE` | `https://zas.red` | The web app the pairing URL points at. |
| `ZAS_API_BASE` | `https://zas.red/api` | The API. |
| `ZAS_TOKEN_BASE` | `https://zas.red/anon-token` | The challenge and token routes. |
| `ZAS_OPRF_BASE` | `https://zas.red/oprf` | The blind key-derivation service. |
| `ZAS_FIREBASE_PROJECT` | `zas-me` | The project whose Firestore the read path queries. |
| `ZAS_FIREBASE_API_KEY` | the public web key | The key used to exchange a custom token for a session. |

Only `--profile` and `ZAS_AGENT_HOME` are worth setting by hand. The rest exist
so the package can be pointed at a test deployment.

## Development

```
git clone https://github.com/soke1556/zas-agent
cd zas-agent
npm ci
npm test
npm run typecheck
npm run build
node dist/cli.js --version
```

This repository is the public mirror of the `agent/` package of Zas's private
monorepo. It is produced by `scripts/export-public.mjs`, which builds the
package with esbuild and uses the build's own metafile to decide what to copy:
`src/`, `test/`, the package files, and the nine `src/shared/*` modules the
agent imports. Those shared modules are the client-side crypto and format code — the
chunker, the manifest, the envelope, the key derivation — that the Zas web app
also ships, which is why the encryption the agent performs is the encryption the
app performs. The Zas server is not open source.

Pull requests are welcome against this repository. The maintainer applies
accepted changes back into the monorepo, and the next export brings them here.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. [SECURITY.md](SECURITY.md) says how,
and what to expect.

## License

MIT. See [LICENSE](LICENSE).
