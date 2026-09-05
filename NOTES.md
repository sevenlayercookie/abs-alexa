# Notes

Things that cost real time to work out, written down so they don't have to be
worked out again. Behaviour of Alexa, of Audiobookshelf, and of the seam between
them — not documentation of this repo's code, which the code and its tests
already cover.

No hostnames, keys, or account details here. Configuration lives in
`lambda/config.js`, which is gitignored.

## Alexa devices

### Long single-file books crash Echo devices

An `.m4b` carries a `moov` atom: an index of where every audio frame sits. The
device must fetch and parse **all of it before playing a single second**. Past
somewhere around 6–14 MB, an Echo gives up with
`MEDIA_ERROR_INTERNAL_DEVICE_ERROR`, and on a large enough index it crashes and
reboots.

Established by experiment:

| `moov` size | position in file | result |
| ----------- | ---------------- | ------ |
| ~5.6 MB     | end              | plays  |
| 14.1 MB     | **end**          | crash  |
| 14.2 MB     | front            | crash  |
| 42.0 MB     | front            | crash  |

The two middle rows are the control: near-identical index size, opposite ends of
the file, same crash. **Position is irrelevant; size is the cause.** Which makes
sense — the index has to be fetched whole either way, and the server supports
range requests, so where it lives only changes how it is fetched.

Index size scales with frame count, so with **duration, not file size**. A 3 GB
/ 8.7 h book has a 4.8 MB index and is fine; a 1.3 GB / 22.6 h book has a 14.2 MB
index and is not. Bytes per second of audio varies by encoder (~174 B/s and
~88 B/s both observed), so measure rather than extrapolate from hours.

To measure without downloading the file, range-request the first 64 bytes and
walk the top-level atoms (4-byte big-endian size, then 4-byte type):

- `ftyp -> moov` — the size field on `moov` is the answer.
- `ftyp -> mdat` — the index is at the end; it is roughly
  `filesize - ftyp - mdat`. Take the total from the `Content-Range` header.

The fix is on the library side: split long books into per-chapter files, which
gives each one a small index. This skill already handles multi-track books and
enqueues the next track as the current one ends.

### "Alexa, stop" arrives as `AMAZON.PauseIntent`

Not `AMAZON.StopIntent`. Confirmed from device logs. Anything that should happen
when a user stops playback has to be handled in the pause path, and the
distinction matters because pause syncs progress while stop also closes the
Audiobookshelf session.

### Custom intents need the invocation name; built-ins do not

While audio is playing, Alexa routes only the `AMAZON.*` playback intents to the
skill from a bare utterance — pause, resume, next, previous, stop, cancel.

Everything custom (`PlayBookIntent`, `PlayLastIntent`, `RecentBooksIntent`,
`GoToChapterX`, `GoBackXTimeIntent`, `GoForwardXTimeIntent`) must be reached
through the invocation name:

> "Alexa, ask *&lt;invocation name&gt;* to play chapter three"

A bare "Alexa, play chapter three" during playback will not reach the skill. This
is Alexa's routing, not something the skill can opt out of.

### One user action can produce several Lambda invocations

A single "Alexa, stop" has been observed arriving as `AMAZON.PauseIntent` **and**
`AudioPlayer.PlaybackStopped`, ~1.5 s apart, in two different Lambda containers.
The device halts audio immediately; the resolved intent follows once speech
recognition finishes.

Containers share no memory, so in-process deduplication cannot see across them.
Any write that could fire from both paths has to be idempotent or guarded on the
server side.

### A failed stream reports offset 0

`AudioPlayer.PlaybackFailed` carries `offsetInMilliseconds: 0` for a stream that
never started. That is "I don't know", not "the listener is at the beginning" —
writing it back is how a 22-hour book gets reset to zero.

### `PlaybackNearlyFinished` can fire immediately

Under a second after `PlaybackStarted` is normal for a single very long track,
and playback continues fine afterwards. It is not a symptom of anything.

## Audiobookshelf

### `GET /api/session/:id` serves only *open* sessions

It returns 404 once the session is closed, and after an Audiobookshelf restart,
which drops every session it was holding. A stream token can therefore name a
session that no longer exists — expect it and fall back rather than treating it
as an error.

### Sessions with no listening time are discarded

A session that is opened and synced but never accrues listening time does not
appear in listening history. During a run where audio never actually played,
every write returned 200 and no history row was created — correctly, since
nothing was listened to.

### `PATCH /api/me/progress/:libraryItemId` needs no session

Idempotent, opens nothing, and creates no listening-history entry. It is the
right way to save a position when there is no usable play session — it cannot
leave a duplicate behind. It records position only, never listening time.

Send it the same auth headers as every other call. A media URL authenticates
with `?token=<api key>`; without it the server answers 401, with it 206.

### Serving media through a reverse proxy is a weak link

Both an intermittent `502` on the media endpoint while the API stayed healthy,
and a `403` rate-limit triggered by ~150 API requests in a few seconds, have been
observed. Either one takes playback down while leaving the API looking fine, and
the 502 hands Alexa an HTML error page in place of audio — which surfaces as
`MEDIA_ERROR_INTERNAL_DEVICE_ERROR` and looks exactly like a device fault.

When walking the library over the API, throttle to roughly 350 ms between
requests and stop on the first 403.

## Deploying

`scripts/deploy.js` deliberately keeps three things that belong to the skill
rather than to this repo: the skill's display name, its invocation name, and the
Alexa-hosted endpoint. The invocation name in
`skill-package/interactionModels/custom/en-US.json` is therefore **not**
necessarily what a live skill answers to — check the deploy output, which prints
the one it preserved.

Interaction-model builds are asynchronous and finish well after the deploy
command returns. Poll for them:

```bash
ask smapi get-skill-status -s <skillId>
```

Code, manifest and interaction model each report status separately, and the
model is usually the slowest.
