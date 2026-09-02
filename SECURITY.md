# Security policy

`zas-agent` holds key material on a developer's machine and speaks to a live
account. A bug here can cost someone their data, so please report it privately
and give us a chance to fix it before it is public.

## Supported versions

| Version | Supported |
| --- | --- |
| latest `0.x` release | Yes |
| anything older | No |

`0.x` moves fast. Fixes land in a new patch release of the latest minor; there
are no backports.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository: open the
**Security** tab and press **Report a vulnerability**. The report stays private
between you and the maintainer until an advisory is published.

Please do not open a public issue, a discussion or a pull request for a
vulnerability. Please do not post it on social media before a fix is out.

Include as much of this as you have:

- what the impact is, in one sentence;
- the version (`npx zas-agent --version`), the OS, and the Node version;
- the steps to reproduce it, or a minimal proof of concept;
- what you expected and what happened instead;
- any log output — with pairing codes, fingerprints, tokens and file contents
  redacted.

## What to expect

- **Acknowledgement within three business days.** If you have not heard back by
  then, the report did not reach us — say so publicly, without details, and we
  will chase it.
- An assessment and a rough timeline after that, and updates as the fix moves.
- Coordinated disclosure: we agree a date, publish a GitHub Security Advisory
  with a CVE where one applies, and release the fix first.
- Credit in the advisory and the changelog, under the name you choose, unless
  you would rather stay anonymous.

## Scope

In scope:

- this package: the CLI, the MCP server, the pairing flow, the local identity
  store, and the client-side crypto under `src/shared/`;
- the pairing and sign-in routes this package talks to
  (`/api/v1/agents/pairings*`, `/anon-token/v1/agents/challenge`,
  `/anon-token/v1/agents/token`), and the agent-facing behaviour of the routes
  it calls afterwards.

Out of scope:

- findings that need a machine already under an attacker's control — the
  identity file is a private key, and reading a private key you already have
  filesystem access to is not a vulnerability;
- reports produced only by a scanner, with no working path to impact;
- rate limits, missing security headers or TLS configuration on the hosted
  service with no demonstrated impact;
- social engineering of the maintainer or of Zas users;
- denial of service by volume.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith,
finds and reports a vulnerability under this policy: who avoids privacy
violations, data destruction and service degradation, only ever tests against
accounts they own, and gives us a reasonable window before disclosing. If you
are unsure whether something is in bounds, ask first through the private report.

There is no bug bounty programme. We say thank you, publicly, and mean it.
