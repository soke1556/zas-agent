# Releasing

For the maintainer. A release is a tag; everything after that is a workflow.

## Cutting one

1. Make sure `main` is green and the working tree is clean.
2. Bump `version` in `package.json`.
3. Move the `## [Unreleased]` entries in `CHANGELOG.md` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section, and update the two link definitions at
   the bottom.
4. Commit: `chore(release): vX.Y.Z`.
5. Tag and push:

   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --follow-tags
   ```

The tag starts `.github/workflows/release.yml`. It checks out the tag, verifies
that `package.json`'s version equals the tag, runs the tests and the build,
publishes to npm with `--provenance`, and then creates the GitHub release with
the changelog section for that version as its notes and the packed tarball
attached.

The workflow uses **npm trusted publishing**: it authenticates with a
short-lived OIDC token from GitHub, so there is no npm token in the repository
and nothing to leak or rotate. If the publish step fails with an
authentication error, the trusted-publisher configuration on npmjs.com is what
to check — not a secret.

## Then: the MCP Registry

The registry entry is `server.json` at the root. After the npm publish
succeeds:

1. Update `version` and `packages[0].version` in `server.json` to the new
   version, and commit.
2. Publish:

   ```
   mcp-publisher login github
   mcp-publisher publish
   ```

The registry proves ownership by reading `mcpName` from the published
`package.json` and matching it against `name` in `server.json`. Both say
`io.github.soke1556/zas-agent`; if either changes, the publish is refused.

## One-time setup

These are done once, by the owner of the account, and are not in this
repository because they cannot be.

### On npmjs.com

npm attaches a trusted publisher to a package that already exists, so the first
release goes through the same workflow with a token that lives exactly as long
as that release:

1. **Access Tokens → Generate New Token → Granular Access Token**: packages and
   scopes *read and write* on all packages (a package that does not exist yet
   cannot be picked by name), *bypass two-factor authentication* enabled, since
   a workflow cannot answer a 2FA prompt, and the shortest expiry the form
   allows.
2. In this repository, **Settings → Environments → release → Environment
   secrets**: add it as `NPM_BOOTSTRAP_TOKEN`.
3. Tag and push `v0.1.0` as above. The workflow sees the secret, publishes
   with it, and attaches provenance.
4. Delete the secret from the environment and revoke the token on npmjs.com.
5. On the package page → **Settings → Trusted publisher**, add a GitHub
   Actions publisher:
   - organization or user: `soke1556`
   - repository: `zas-agent`
   - workflow filename: `release.yml`
   - environment: `release`
6. Under **Publishing access**, require two-factor authentication and disallow
   tokens, so from now on only the workflow can publish.
7. Require two-factor authentication on the npm account.

Every later release runs with no token anywhere.

### On GitHub

- **Settings → Environments →** create `release`. Add the maintainer as a
  required reviewer if you want a human press before every publish.
- **Settings → Code security →** turn on **Private vulnerability reporting**,
  Dependabot alerts and Dependabot security updates.
- **Settings → Rules / Branches →** protect `main`: require a pull request,
  require the `ci` checks to pass, and forbid force pushes.
- **Settings → Actions → General →** set workflow permissions to
  *Read repository contents*, so a workflow has to ask for anything more.

## After a release

- Check the npm page shows the provenance badge.
- Check the GitHub release has the tarball attached.
- Check the OpenSSF Scorecard badge on the README still resolves.
