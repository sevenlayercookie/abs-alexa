const { skillBuilder } = require("../lambda/index");
const express = require("express");
const { ExpressAdapter } = require("ask-sdk-express-adapter");
const { requestLogger } = require("./logger");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { SERVER_URL, ABS_API_KEY } = require("../lambda/lib/settings");
const DEBUG = false; // Set to true to test without certificates

const app = express();
const PORT = process.env.PORT || 8431;

const LogRequestInterceptor = {
  process(handlerInput) {
    console.log("==== INCOMING ALEXA REQUEST ====");
    console.log(JSON.stringify(handlerInput.requestEnvelope, null, 2));
  },
};

const LogResponseInterceptor = {
  process(handlerInput, response) {
    console.log("==== OUTGOING ALEXA RESPONSE ====");
    console.log(JSON.stringify(response, null, 2));
  },
};

const skill = DEBUG
  ? skillBuilder
      .addRequestInterceptors(LogRequestInterceptor)
      .addResponseInterceptors(LogResponseInterceptor)
      .create()
  : skillBuilder.create();

app.use(requestLogger);

const adapter = new ExpressAdapter(skill, DEBUG, DEBUG);

app.post("/", adapter.getRequestHandlers());

const proxy = createProxyMiddleware({
  target: SERVER_URL,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req, res) => {
      const token = req.query.token;
      if (!token || token !== ABS_API_KEY) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Unauthorized: Invalid or missing token" }),
        );

        proxyReq.destroy();
      }
    },
  },
});
app.get("/api/items/:itemId/cover", proxy);
app.get("/api/items/:itemId/file/:fileId", proxy);

// Log the unmatched request details
app.use((req, res, next) => {
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
app.listen(PORT, (err) => {
  if (err) console.error(err);
  else console.log(`Alexa Skill endpoint listening on port ${PORT}`);
});
