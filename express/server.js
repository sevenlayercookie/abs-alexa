const { skillBuilder } = require("../lambda/index");
const express = require("express");
const { ExpressAdapter } = require("ask-sdk-express-adapter");

const app = express();
const PORT = process.env.PORT || 8431;
const skill = skillBuilder.create();

const adapter = new ExpressAdapter(skill, true, true); // Set to false to test without certificates

app.post("/", adapter.getRequestHandlers());

app.use((req, res, next) => {
  // Log the unmatched request details
  console.log(`Unmatched request: ${req.method} ${req.originalUrl}`);

  // Optionally pass a 404 error down the chain or respond directly
  res.status(404).json({
    error: {
      status: 404,
      message: "Route not found",
      path: req.originalUrl,
    },
  });
});

// Start the server
app.listen(
  PORT,
    (err) => {
if(err)
    console.error(err);
else
      console.log(`Alexa Skill endpoint listening on port ${PORT}`);
  },
);
