const { skillBuilder } = require('../lambda/index');
const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');

const app = express();
const PORT = process.env.PORT || 8080;
const skill = skillBuilder.create()


const adapter = new ExpressAdapter(skill, true, true); // Set to false to test without certificates

app.post('/', adapter.getRequestHandlers());

// Start the server
app.listen(PORT, () => {
    console.log(`Alexa Skill endpoint listening on port ${PORT}`);
}, (err) => {
    console.error(err)
});