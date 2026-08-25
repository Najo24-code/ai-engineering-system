const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../src/server.js");
const pkg = require("../package.json");

function pedir(ruta) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      http
        .get(`http://localhost:${port}${ruta}`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => server.close(() => resolve({ status: res.statusCode, body: data })));
        })
        .on("error", (e) => server.close(() => reject(e)));
    });
  });
}

test("laboratory test", () => {
  assert.strictEqual(1 + 1, 2);
});

test("GET /version returns package.json version", async () => {
  const r = await pedir("/version");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { version: pkg.version });
});

test("GET /usuarios/:id devuelve el usuario", async () => {
  const r = await pedir("/usuarios/1");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { id: 1, nombre: "beto" });
});

test("GET /usuarios/:id devuelve 404 si no existe", async () => {
  const r = await pedir("/usuarios/99");
  assert.strictEqual(r.status, 404);
});

test("GET /usuarios/:id devuelve 404 en el límite (id == length)", async () => {
  const r = await pedir("/usuarios/3");
  assert.strictEqual(r.status, 404);
});
