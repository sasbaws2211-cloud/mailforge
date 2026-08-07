# Contributing to Claros

## How this project works

Claros uses an open source, not open contribution model. Development happens in a private
repository. Releases are assembled, verified, and published here as squashed commits. This
repository is output, not a collaboration space.

**Pull requests are not accepted and are closed automatically.**

This is not a temporary state. It reflects how the project is built: one maintainer, one
direction, one private codebase that gets periodically mirrored here. External patches
cannot be merged into a repo that is not the source.

## What you can do

**File a bug report.** Include what you expected, what happened, steps to reproduce, and
your environment (OS, Docker version, Postgres version, how you deployed). Clear reports
with reproduction steps are the most useful thing an external contributor can provide.

**Request a feature.** Open an Issue. No commitment, but useful ideas surface in the
roadmap.

**Report a security issue privately.** See [SECURITY.md](./SECURITY.md). Do not open a
public Issue for vulnerabilities.

## What this project will not accept

- Pull requests (closed automatically)
- Patches via email or other channels
- Changes to documentation, tests, or configuration via PR

If you have found a bug that is blocking you, file an Issue. If the fix is genuinely urgent
and simple, describe it in the Issue; the maintainer can apply it to the private repo and
release.

## Why

The open source is real: MIT license, full engine, nothing crippled. The development model
is the constraint, not the license. A single maintainer moving fast in a specific direction
cannot also maintain an external contributor workflow. SQLite operates this way. So does
this project.
