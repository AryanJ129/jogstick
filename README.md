# Jogstick

An open-source desktop app that turns an Xbox controller into an editing surface for DaVinci Resolve
(analog jog, trigger shuttle, layers, color wheels), built to work on Resolve Free.

**Status: early development. There is no app to install yet.** Right now the repo contains the
engine and native layer under construction, plus `jogstick-probe`, a tool testers run to measure how
Resolve on their machine responds (see [docs/testing-with-a-friend.md](docs/testing-with-a-friend.md)).

Features are listed here only once a test or a recording covers them.

Not affiliated with Blackmagic Design or Microsoft. "for DaVinci Resolve" describes compatibility only.

## Development

```sh
pnpm i
pnpm test                      # engine tests
pnpm -F @jogstick/native build # Node addon (Rust)
scripts/harness-mac.sh         # macOS: injection self-test against jogstick-harness
```

See `BUILD_BRIEF.md` (the spec) and `ARCHITECTURE.md` (what's built and why).

MIT licence.
