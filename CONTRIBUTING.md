# Contributing to Claros

Thank you for your interest in Claros.

## Development Model

Claros uses an **open source, not open contribution** model - similar to SQLite. Here is what that means:

- Development happens in a private repository.
- Releases are assembled, verified, and mirrored here as single squash-commits.
- The public repository is output, not a collaboration space.

**Pull requests are automatically closed.** This is not unfriendly - it is a deliberate choice to keep the codebase coherent under solo maintainership. The project moves fast and in a specific direction; accepting external patches would slow both the contributor (waiting for review) and the maintainer (context-switching to evaluate changes against an unpublished roadmap).

## How You Can Help

**Bug reports are welcome.** If you find a bug, please open an Issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Docker version, Postgres version)

Clear bug reports with reproduction steps are genuinely valuable and appreciated.

**Feature requests:** Open an Issue. No guarantees, but good ideas get heard. The roadmap is informed by real usage patterns.

**Security issues:** See [SECURITY.md](./SECURITY.md) for private disclosure.

## Why This Model?

Claros is maintained by a solo developer building a commercial product on top of a genuinely open engine. The SQLite model keeps both sides honest:

- The open source is real (MIT, full product, not crippled).
- The development stays fast (no PR review bottleneck).
- The direction stays coherent (one vision, executed).

This model works for SQLite (billions of deployments, zero external commits). It can work here too.

## Code of Conduct

Be respectful in Issues. Technical disagreement is fine; personal attacks are not. Life is short.
