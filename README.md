# ABS-Alexa

**Alexa Skill for interfacing with Audiobookshelf**

This is an Alexa Skill that can be used to control your personal Audiobookshelf server.

## Requirements:
1. Publicly reachable Audiobookshelf server
2. Amazon Developer account (free)
3. Place to host the skill (either with Alexa-hosted Lambda function or self-hosted)

## Features:
- Play last played audiobook ("Alexa, play)
- Play audiobook by title (e.g., "Alexa, play *A Game of Thrones* by George R.R. Martin" or "Alexa, play *Hitchhiker's Guide to the Galaxy*")
- Seek within a book (e.g., "Alexa, skip forward 2 minutes")
- Skip to the next/previous chapter (e.g., "Alexa, go back a chapter")
- Progress tracking (listening sessions will be saved on the Audiobookshelf server)
- attempts to resolve the book and author name requested using Amazon resolution services
- performs an an API "search" that is built-in to ABS
- if this fails, pulls all books from library and then performs a fuzzy search (effective, but may be resource intensive on large libraries)

## Installation:
1) Fork this repo
2) Provide your **Audiobookshelf API key** and **server URL**. Either way works; environment variables take precedence.
   - **Environment variables** (recommended): set `ABS_API_KEY` and `SERVER_URL`. On Alexa-hosted, use the 'Code' tab of the Developer Console.
   - **Config file**: `cd lambda && cp config.example.js config.js`, then edit it. `config.js` is gitignored, so your key is never committed — do not rename or force-add it.

   Optional: `USER_AGENT`, `BACKGROUND_URL` (background art for screen devices; defaults to the current book's cover), and `CFAccessClientId` / `CFAccessClientSecret` for servers behind Cloudflare Access.
3) Follow the instructions here: https://developer.amazon.com/en-US/docs/alexa/hosted-skills/alexa-hosted-skills-git-import.html#import
4) Set your skill invocation name and build the skill
5) Save and deploy the skill
6) If using Alexa-hosted, go to the 'Test' tab of Developer Console, and enable skill testing for 'Development'

## Usage:
- Once installed, call the skill using the invocation name you chose (e.g. "Alexa, Audiobook shelf"
- Then:
  - "Play": either resumes currently playing book, or plays your last listened to audiobook
  - "Pause": pauses audio and updates ABS server on progress
  - "Stop/close/cancel": closes the ABS listening session and closes the Alexa skill session
  - "Play A Game Of Thrones" - attempts to find any book matching this title and plays it
  - "Play A Game Of Thrones by George R.R. Martin" - plays the matching book written by the stated author
  - "Next/Previous": Goes to next/previous chapter
  - "Go forward/back X minutes/seconds/hours": Goes forward or back X number of seconds, minutes, or hours
- Though there are some useful intents, I find that the most reliable way of using the skill is to just say "Play" to resume last listened to audiobook
  - "Play" is a built-in intent, which Alexa tends to execute more reliably

## Development:

Two different Node versions are in play, and it matters:

- **The deployed skill runs `nodejs16.x`.** Alexa-hosted fixes the runtime when
  the skill is created and offers no alternative -- skills created from the
  developer console and from the CLI both come out as `nodejs16.x`. Anything
  under `lambda/` must therefore stay Node 16 compatible: no `fetch`, no
  `structuredClone`, no `Array.prototype.at`, no `Object.hasOwn`.
  `npm run lint` enforces this, so you get an error rather than a runtime
  failure in production.
- **The test harness needs Node 18+**, because it uses the built-in `node:test`
  runner. `.nvmrc` pins 22 for local development.

Node 24 is avoided regardless: its AWS Lambda runtime dropped callback-style
handlers, which is exactly what the ASK SDK's `.lambda()` produces.

```bash
npm install          # test tooling (repo root)
npm install --prefix lambda   # the skill's own dependencies
npm test             # 16 tests, ~0.3s, no server or device needed
npm run lint
```

`npm test` replays recorded Audiobookshelf responses from `test/fixtures/`, so
it needs no network. See [test/README.md](test/README.md) for how to re-record
them and what the tests do and do not cover.

CI runs both commands on Node 20 and 22 for every push.

### Optional: the ASK CLI

Not required to develop or deploy, but it covers the one thing the local tests
cannot -- whether Alexa maps a spoken phrase to the right intent. Install it
globally rather than as a project dependency; it pulls in ~485 packages.

```bash
npm install -g ask-cli
ask configure                      # browser sign-in to your Amazon developer account
ask smapi list-skills-for-vendor   # find your skill id
```

`ask dialog` needs nothing else -- no `ask init`, no `ask-resources.json`.
Those are only for letting the CLI manage deployment, which an Alexa-hosted
skill does not need: Amazon provisions the Lambda and sets the endpoint itself.
Running plain `ask init` here would configure the project to deploy to a
*new* Lambda in your own AWS account, which is not how this skill is hosted.

- `ask dialog -s <skill-id>` — type utterances and get real Alexa responses,
  multi-turn. `--save-skill-io` writes the request/response JSON to a file, and
  `--replay` re-runs a recorded session.
- `ask run` — routes live requests from a real Echo or the simulator to the code
  on your machine, so you can test a change without deploying. `--watch`
  restarts on edit.

### Do not strip the endpoint from skill.json

`manifest.apis.custom.endpoint` looks like a placeholder in this repo, and for a
*new* skill it is -- Alexa-hosted fills it in at creation with
`arn:aws:lambda:<region>:905418158688:function:<skillId>:Release_0`.

But once a skill exists, that field is how the developer console knows the code
is Alexa-hosted. Pushing a manifest with it removed makes the console report:

> Your default endpoint has changed and the code below is no longer hosted by Alexa.

The code is fine when this happens; only the manifest is wrong. Restore the
`endpoint` and the three `regions` entries (NA/EU/FE, in us-east-1, eu-west-1 and
us-west-2) and the console reconnects. So when updating an existing skill's
manifest, always start from `ask smapi get-skill-manifest` rather than from this
repo's `skill.json`.

`.ask/` holds deployment state and account-specific resource ids and is
gitignored. If you ever do adopt CLI-managed deployment, `ask-resources.json`
is project configuration and should be committed.
## Background:
- ABS-Alexa initially required creating dynamic RSS feeds. However, authentication via API in URL allows for direct play on Echo devices. RSS feeds are no longer required.

## Cloudflare and other reverse proxies

The skill runs as an AWS Lambda, so requests to your Audiobookshelf server
arrive from an Amazon datacenter IP, not from your home network. If the server
sits behind Cloudflare with bot protection enabled, those requests get a managed
challenge and the skill sees:

```
Server responded to https://your-abs-host/api/libraries with status code 403:
<!DOCTYPE html>... <title>Just a moment...</title> ...
```

The skill is working correctly here; it is being blocked before it reaches
Audiobookshelf. Testing with `curl` from your own network will not reproduce it,
because your own IP is not challenged.

Fixes, in rough order of preference:

- Add a Cloudflare WAF rule that skips bot protection for the Audiobookshelf
  hostname, or at least for `/api/*`.
- Use a Cloudflare Access service token and set `CFAccessClientId` and
  `CFAccessClientSecret` in your config -- the skill already sends these as
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers when set.
- Turn off Bot Fight Mode for that hostname.

## Known Issues:
- Alexa Skills have many limitations. Most bugs relate to Alexa losing memory of session details or forgetting that the skill is running.
- Some requests may require the user to restart the Alexa session after an intent is executed.
- This is particularly true with certain custom intents, such as:
  - Seeking intents (e.g., "Go backwards 5 minutes")
  - Playing a book by title (e.g., "Play *A Game of Thrones*")
- If book is not initially found using ABS API search function, the skill then pulls all books in user's library and performs a fuzzy search
  - on large libraries, this may take a long time (I have tested it on 1000 book library and it completes search in 1-3 seconds)
- This skill is set to only search libraries that are set as "audiobook only" -- if you have audiobooks in any other kind of library, they will not be searched
- This skill has only been tested in very simple library configurations so far and may have issues with complex library set ups

## To Do:
- [ ] Implement self-hosting (currently, the skill only runs using AWS Lambda function)
    - This is easy to achieve using Express.JS, but I have not yet included this in the repository.
- [ ] Consider implementing persistent attributes to give Alexa a longer "memory" (store play sessions in a local database)
- [ ] Add other intents, such as:
  - [ ] "Start the book over"
  - [ ] "Go to chapter 12"
