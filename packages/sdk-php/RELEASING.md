# Releasing the PHP SDK

Packagist needs a `composer.json` at the root of a repository, and this SDK lives in a folder of the monorepo. So releases go to a read-only mirror, `sasbaws2211-cloud/loomail-php`, and Packagist tracks that. A GitHub Action does the copying (`.github/workflows/release-php.yml`).

## To release

1. Merge your change to `main`. Update nothing else: there is no version number in `composer.json`, the tag is the version.
2. Tag the commit and push the tag:

   ```bash
   git tag php-v0.1.1
   git push origin php-v0.1.1        # "origin" must be the mailforge repository
   ```

3. The workflow tests the SDK on PHP 8.1 and 8.3, then publishes the SDK folder's history to the mirror's `main` and tags the mirror `v0.1.1`. Packagist picks the new version up from the mirror within a minute or two.

The release is refused (and nothing is changed) when:

- the tag is not `php-vMAJOR.MINOR.PATCH` (a suffix such as `-rc.1` is fine);
- the mirror already has that version (published versions are never replaced: bump the number);
- the tagged commit is not on `main`;
- the tests fail;
- the mirror's history has diverged from the monorepo's (the action never force-pushes).

## One-time setup

1. **A deploy key.** Make a key pair that exists only for this:

   ```bash
   ssh-keygen -t ed25519 -N "" -C "loomail-php release" -f loomail-php-deploy
   ```

2. In the **mirror** repo (`loomail-php`): Settings, Deploy keys, Add deploy key. Paste `loomail-php-deploy.pub` and tick **Allow write access**.
3. In the **monorepo** (`mailforge`): Settings, Secrets and variables, Actions, New repository secret named `LOOMAIL_PHP_DEPLOY_KEY`, value is the whole content of the private file `loomail-php-deploy`.
4. Delete both local key files (or keep the private one in a password manager). Do not commit them.
5. On Packagist, make sure the package auto-updates (the GitHub webhook on `loomail-php`). Optional backup: add `PACKAGIST_USERNAME` and `PACKAGIST_API_TOKEN` secrets and the workflow also pings Packagist's API.

## Notes

- The mirror is a copy: do not commit to it by hand, or the next release will refuse because the histories diverged.
- The split is deterministic, so re-running a release for the same history produces the same commits. That is why each release is a plain fast-forward.
- The mirror's `main` and tag `v0.1.0` were made by hand from the first split and match what the action produces.
