const express = require("express");

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

module.exports = app;
