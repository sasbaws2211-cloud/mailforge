#!/usr/bin/env bash
# Publishes the PHP SDK to its read-only mirror repo, which is what Packagist reads (Packagist needs composer.json at the
# root of a repository, and ours lives in packages/sdk-php).
#
#   TAG         the release tag in this repo, such as php-v0.1.1            (required)
#   MIRROR_URL  where the mirror lives (ssh/https URL, or a path in tests)   (required)
#   MIRROR_BRANCH  the mirror's branch, default main
#
# What it does, in order, and refuses at the first thing that looks wrong:
#   1. the tag must be php-vMAJOR.MINOR.PATCH (a pre-release suffix such as -rc.1 is allowed)
#   2. the mirror must not already have that version: a published version is never replaced
#   3. split packages/sdk-php out of this repo's history (deterministic: the same history always gives the same commits,
#      so each release is a plain fast-forward of the mirror)
#   4. push the branch WITHOUT force, then push the tag v<version> on the same commit
#
# Run from the root of the monorepo with full history (actions/checkout with fetch-depth: 0).
set -euo pipefail

fail() { echo "release-php: $*" >&2; exit 1; }

tag="${TAG:-}"
mirror="${MIRROR_URL:-}"
branch="${MIRROR_BRANCH:-main}"
prefix="packages/sdk-php"

[ -n "$tag" ] || fail "TAG is not set"
[ -n "$mirror" ] || fail "MIRROR_URL is not set"

if [[ ! "$tag" =~ ^php-v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$ ]]; then
  fail "'$tag' is not a release tag. Use php-vMAJOR.MINOR.PATCH, for example php-v0.1.1"
fi
version="${BASH_REMATCH[1]}"
mirror_tag="v${version}"

git rev-parse --verify --quiet "${tag}^{commit}" >/dev/null || fail "tag '$tag' does not exist in this repository"
[ -f "$prefix/composer.json" ] || fail "$prefix/composer.json not found (run from the repository root)"

if git ls-remote --exit-code --tags "$mirror" "refs/tags/${mirror_tag}" >/dev/null 2>&1; then
  fail "the mirror already has ${mirror_tag}. A published version is never replaced: bump the version and tag again"
fi

echo "Splitting ${prefix} at ${tag}..."
split="$(git subtree split --prefix="$prefix" "${tag}^{commit}" 2>/dev/null | tail -n 1)"
[[ "$split" =~ ^[0-9a-f]{40}$ ]] || fail "the split did not produce a commit (got: '$split')"

echo "Pushing ${split} to ${branch} (no force)..."
if ! git push "$mirror" "${split}:refs/heads/${branch}"; then
  fail "the mirror's ${branch} is not an ancestor of this release (its history has diverged). Nothing was tagged. Fix the mirror by hand: this script never force-pushes"
fi

echo "Tagging ${mirror_tag}..."
git push "$mirror" "${split}:refs/tags/${mirror_tag}"

echo "Released PHP SDK ${version}: mirror ${branch} and ${mirror_tag} are at ${split}"
