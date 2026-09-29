import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("standalone preview reports it is outside the host and makes no bridge requests", () => {
  const html = fs.readFileSync(new URL("../ui/connection.html", import.meta.url), "utf8");
  const labels = {};
  const window = { postMessage() { throw new Error("must not contact a host"); } };
  window.parent = window;
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document: { getElementById: id => labels[id] ||= {} },
  });
  assert.equal(labels.bridge.textContent, "Fuera del chat");
  assert.equal(labels.surface.textContent, "Vista local");
});

test("connection panel negotiates once, ignores foreign frames and never dispatches", () => {
  const html = fs.readFileSync(new URL("../ui/connection.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sent = [], labels = {};
  let handler;
  const parent = { postMessage: value => sent.push(value) };
  const sandbox = { window: { parent, addEventListener: (_type, fn) => { handler = fn; } },
    document: { getElementById: id => labels[id] ||= {} }, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(script, sandbox);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "ui/initialize");
  const payload = { jsonrpc: "2.0", id: "tfo-connect-v1", result: { hostCapabilities: { message: {} } } };
  handler({ source: {}, data: payload });
  assert.equal(sent.length, 1);
  handler({ source: parent, data: payload });
  assert.equal(labels.bridge.textContent, "Conectado");
  assert.equal(labels.messages.textContent, "Ofrecido; no probado");
  handler({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
    structuredContent: { diagnosticOnly: true, mcpConnected: true, surface: "chatgpt-chat" },
  } } });
  assert.equal(labels.surface.textContent, "Chat normal");
  assert.deepEqual(sent.map(x => x.method), ["ui/initialize", "ui/notifications/initialized"]);
});
