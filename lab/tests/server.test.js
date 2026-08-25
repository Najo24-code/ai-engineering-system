const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../src/server.js");
const pkg = require("../package.json");

test("laboratory test", () => {
  assert.strictEqual(1 + 1, 2);
});

test("GET /version returns package.json version", async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}/version`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }).on("error", reject);
    });

    assert.strictEqual(response.status, 200);
    const parsed = JSON.parse(response.body);
    assert.deepStrictEqual(parsed, { version: pkg.version });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
