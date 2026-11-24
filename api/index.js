// Vercel serverless entry-point — re-exports the Express app from server.js.
// server.js only calls app.listen() when VERCEL is not set, so there is no
// double-listen issue here.
const app = require("../server.js");
module.exports = app;
