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
- if this fails, pulls all books from library and then performs a fuzzy search (may be resource intensive on large libraries)

## Installation:
1) Fork this repo
2) Edit the config.js file to include your **Audiobookshelf API key** and **server URL** (you can do this in the 'Code' tab of Developer Console if using Alexa-hosted)
1) Follow the instructions here: https://developer.amazon.com/en-US/docs/alexa/hosted-skills/alexa-hosted-skills-git-import.html#import
2) Set your skill invocation name and build the skill
3) Edit the config.js file to include your **Audiobookshelf API key** and **server URL** (you can do this in the 'Code' tab of Developer Console if using Alexa-hosted)
4) Save and deploy the skill
5) If using Alexa-hosted, go to the 'Test' tab of Developer Console, and enable skill testing for 'Development'

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

## Background:
- Alexa requires any audio track to be publicly accessible and does not support passing cookies or authorization headers.
- Audiobookshelf supports publicly accessible URLs (share API), but this requires passing a cookie. RSS feeds are a workaround.
  - **RSS Feeds:** This function allows user to create a publicly accessible URL without a cookie or header needed.
- **ABS-Alexa** uses this as a workaround by creating an RSS feed when a user requests to listen to a book.
  - Until Audiobookshelf provides another method for creating publicly accessible URLs, I believe this workaround is the best option.

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
- [ ] Consider implementing persistent attributes to give Alexa a longer "memory" (store play sessions in a local database)
- [ ] Add other intents, such as:
  - [ ] "Start the book over"
  - [ ] "Go to chapter 12"
