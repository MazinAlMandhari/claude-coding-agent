# CLAUDE.md

<!-- Template for new projects. Fill every section, delete the hints, keep under 200 lines.
     Only write what Claude cannot work out from the code itself. -->

Read `docs/HANDOVER.md` (or the spec in `docs/`) before starting work.

## What this is

<!-- Two or three sentences: what it does, who uses it, what stage it is at (prototype, beta, production). -->

## Status

- Done: <!-- milestone, test count -->
- Next: <!-- the next milestone and where its spec lives -->

## Commands

```
<set up the environment>
<run all tests>
<run one test>
<lint / format>
<run the app>
```

Settings come from `.env` (copy `.env.example`). Never commit `.env`. Never print or log a key.

## Architecture rules (do not break these)

<!-- Numbered, verifiable rules: which layer may import what, where money/time/config are handled,
     where an LLM is allowed to act (only through tools), how users or tenants are kept apart. -->
1.
2.

## Conventions

- <!-- language version, typing, validation library -->
- Money is a decimal type; times stored in UTC, timezone-aware; local timezone: <!-- e.g. Europe/London -->
- Tests first for rules (money, time, permissions); fixed `now`; no real network or model calls.
- Commit message convention: <!-- e.g. imperative summary line -->
- No new dependency without a reason in the commit message.

## Data and privacy

<!-- What personal data this project holds, where consent is given, how long it is kept, where it
     is hosted, and which data-protection law applies. -->

## Out of scope (for now)

<!-- So the agent doesn't build it early. -->
