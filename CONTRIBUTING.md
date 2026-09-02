# Contributing

Thanks for looking. Bug reports, small fixes and well-argued proposals are all
welcome.

One thing to know before you start: **this repository is a mirror.** The
package lives in Zas's private monorepo, in a directory called `agent/`, and
this repository is produced from it by `scripts/export-public.mjs`. That script
is here so you can read it. What it means for you in practice:

- Pull requests are opened against this repository, reviewed here, and applied
  by the maintainer into the monorepo. The next export brings them back here,
  so your commit may land as part of a larger export commit rather than as your
  own. You keep the credit in the changelog and in the PR.
- The `src/shared/` directory is copied from the monorepo, and the Zas web app
  ships the same modules. A change there has to hold for both, so expect more
  questions on a shared-module PR than on one under `src/`.
- The Zas server is not open source. A change that needs a server change can
  still be a good issue — say what you need and why — but it cannot be a
  complete pull request here.

## Setting up

```
git clone https://github.com/soke1556/zas-agent
cd zas-agent
npm ci
```

Node 20 or newer. The repository pins Node 22 in `.nvmrc`, which is what CI
runs on by default; the test matrix also covers Node 20.

## The loop

```
npm test          # vitest, no network, no account needed
npm run typecheck # tsc, strict
npm run build     # esbuild → dist/cli.js
node dist/cli.js --version
```

Everything in `test/` runs offline against fakes. If a change needs a real
account or the Firebase emulator, it belongs in the monorepo's end-to-end suite,
which is not exported — say so in the PR and the maintainer will run it.

Write the test first where you can. Every behaviour in `src/` has one, and a
pull request that changes behaviour without touching a test will be asked for
one.

## Style

- TypeScript, strict, ES modules, `.js` extensions on relative imports
  (NodeNext resolution).
- Comments explain **why**, not what. The existing files are the reference:
  they tend to say what would go wrong without the line.
- Two spaces, single quotes, semicolons. `.editorconfig` covers the rest.

### Spanish strings

Everything a person reads in a terminal is Spanish (Argentine), and everything a
model reads — the MCP tool descriptions — is English. When you add or change a
Spanish string:

- **Voseo.** `Corré`, `Probá`, `Volvé a emparejar`, `Esperá`. Never `corre`,
  `prueba`, `vuelve`.
- **Declarative.** Say what happened and what to do about it. No apologies, no
  exclamation marks, no "oops".
- **One sentence where one sentence will do**, and never a raw error code or a
  stack trace where a sentence belongs.
- Keep the pair: every code in `src/errors.ts` carries both an `es` and an `en`
  sentence, and a test enforces that neither is missing.

## Commits

- One logical change per commit.
- Subject in the imperative, lower case after the type, no trailing period:
  `fix(pair): stop polling after the pairing expires`.
- Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- The body says why, if the subject cannot.

No DCO sign-off and no CLA. Opening a pull request means you are licensing your
contribution under the MIT licence in [LICENSE](LICENSE).

## Pull requests

Use the template. Say what changed, why, and how you tested it. Small and
focused beats large and complete: a 40-line PR gets reviewed the same day, a
900-line one waits for a quiet weekend.

For anything security-sensitive — key handling, the pairing flow, what reaches
disk — do not open a pull request first. Read [SECURITY.md](SECURITY.md) and
report it privately.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
