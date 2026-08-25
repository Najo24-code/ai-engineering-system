const express = require("express");
const pkg = require("../package.json");

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/version", (_req, res) => {
  res.json({ version: pkg.version });
});

module.exports = app;
