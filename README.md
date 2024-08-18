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

## Installation:
1) Follow the instructions here: https://developer.amazon.com/en-US/docs/alexa/hosted-skills/alexa-hosted-skills-git-import.html#import
2) Set your skill invocation name
3) Build your skill
4) Edit the config.js file to include your **Audiobookshelf API key** and **server URL**
5) Save and deploy the skill
6) Use the skill!

## Usage:
- Though there are some useful intents, I find that the most reliable way of using the skill is to just say "Play" to resume last listened to audiobook
  - "Play" is a built-in intent, which Alexa tends to execute more reliably

## Background:
- Alexa requires any audio track to be publicly accessible and does not support passing cookies or authorization headers.
- Audiobookshelf currently does not support publicly accessible URLs, with one exception:
  - **RSS Feeds:** These allow a publicly accessible URL without a cookie or header needed.
- **ABS-Alexa** uses this as a workaround by creating an RSS feed when a user requests to listen to a book.
  - Until Audiobookshelf provides another method for creating publicly accessible URLs, this workaround is the best option.

## Known Issues:
- Alexa Skills have many limitations. Most bugs relate to Alexa losing memory of session details or forgetting that the skill is running.
- Some requests may require the user to restart the Alexa session after an intent is executed.
- This is particularly true with certain custom intents, such as:
  - Seeking intents (e.g., "Go backwards 5 minutes")
  - Playing a book by title (e.g., "Play *A Game of Thrones*")

## To Do:
- [ ] Implement self-hosting (currently, the skill only runs using AWS Lambda function)
- [ ] Consider implementing persistent attributes to give Alexa a longer "memory"
- [ ] Add other intents, such as:
  - [ ] "Start the book over"
  - [ ] "Go to chapter 12"
