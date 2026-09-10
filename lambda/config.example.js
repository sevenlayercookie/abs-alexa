// config.example.js
//
// Copy this file to config.js and fill in your values:
//     cp config.example.js config.js
//
// config.js is gitignored so your credentials are never committed.
//
// Every value below can also be supplied as an environment variable of the
// same name, which takes precedence over this file. Prefer environment
// variables where your host supports them (Alexa-hosted: Code tab ->
// Environment Variables; self-hosted: your process manager or .env).
module.exports = {
    // Required.
    ABS_API_KEY: 'xxxxxx',
    SERVER_URL: 'https://abs.domain.tld',

    // Sent as the User-Agent on every Audiobookshelf request.
    USER_AGENT: 'AlexaSkill',

    // Optional. Background art for screen devices (Echo Show, Fire TV).
    // Leave unset to use the cover of the book currently playing.
    // BACKGROUND_URL: 'https://example.com/background.jpg',

    // Optional. Enable transcode proxy mode for all requests (abs-transcode-proxy).
    // When enabled, change SERVER_URL above to your abs-transcode-proxy URL instead
    // of pointing directly at Audiobookshelf. Audio file requests will include
    // proxyTranscode=true and startTime=<seconds>, enabling on-the-fly
    // transcoding to CBR 64 kbps MP3 with server-side seeking.
    // USE_PROXY: false,

    // Optional. Only needed if your server sits behind Cloudflare Access.
    // CFAccessClientId: 'xxxxxxxxx.access',
    // CFAccessClientSecret: 'xxxxxxxx'
};
