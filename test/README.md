# Tests

One command tells you whether you broke the skill:

```bash
npm test
```

No Echo, no deploy, no Audiobookshelf server needed — requests are served from
recorded fixtures in `test/fixtures/`.

## What these tests are

They are **characterisation tests**. They assert that the skill behaves the way
it behaves *today*, not that the behaviour is correct. A failure means
*something changed* — look at the diff and decide whether you meant it.

That is the point: this codebase has no spec, so "correct" is defined as "what
it did before the change". These exist to make refactoring safe.

## Recording fixtures

Fixtures are captured once against a real Audiobookshelf server:

```bash
ABS_API_KEY=... SERVER_URL=http://your-abs-host:13378 npm run record
```

Credentials are read from the environment or `lambda/config.js`, are used only
to talk to your server, and are scrubbed out before anything is written to
disk. Review `test/fixtures/abs.json` before committing — it is a copy of real
responses from your library.

## Fixtures go stale, silently

`test/fixtures/abs.json` is frozen at the moment it was recorded. If
Audiobookshelf changes a response shape in a later version, every test here
stays green while the real skill breaks -- the fixtures keep answering in the
old shape forever.

Nothing detects this automatically. Re-record after upgrading your server, and
occasionally regardless:

```bash
npm run record        # re-capture from a live server
npm test              # see whether any baseline moved
```

A diff after re-recording means the server's responses changed. That is worth
reading rather than accepting blindly.

`npm run test:live` is the other half of this: it talks to the real server every
time, so it notices what frozen fixtures cannot.

## When a test fails

1. Read the diff. It shows exactly what changed in the response Alexa receives.
2. If the change was **not** intended, you have found a regression.
3. If it **was** intended, re-record the baseline:

```bash
UPDATE_SNAPSHOTS=1 npm test
```

Never re-record just to turn a red test green — that throws away the safety net.

## Why the fixture server runs in its own process

The skill talks to Audiobookshelf through `sync-request`, which blocks the
calling thread. A fixture server sharing that event loop could never reply and
the tests would deadlock. `helpers/server-main.js` therefore runs in a forked
process. This is not incidental — it will bite anyone who tries to simplify it.

## Layout

| File | Purpose |
|---|---|
| `skill.test.js` | The tests |
| `scenarios.js` | The conversations under test, shared by tests and recorder |
| `record.js` | Captures fixtures from a live server |
| `helpers/alexa.js` | Builds Alexa request envelopes, invokes the skill |
| `helpers/abs-server.js` | Record / replay stand-in for Audiobookshelf |
| `helpers/server-process.js` | Runs that server in its own process |
| `helpers/scrub.js` | Strips keys, tokens and timestamps |
| `helpers/snapshot.js` | Stores and compares baselines |
