const express = require("express");
const pkg = require("../package.json");

const app = express();

const usuarios = [
  { id: 0, nombre: "ana" },
  { id: 1, nombre: "beto" },
  { id: 2, nombre: "carmen" },
];

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/version", (_req, res) => {
  res.json({ version: pkg.version });
});

app.get("/usuarios/:id", (req, res) => {
  const id = Number(req.params.id);

  if (Number.isNaN(id) || id < 0 || id >= usuarios.length) {
    return res.status(404).json({ error: "no existe" });
  }

  res.json(usuarios[id]);
});

module.exports = app;
