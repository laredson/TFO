import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("the installed bundle matches its source and starts after copying outside the repository", t => {
  const source = path.join(repo, "plugins", "tfo");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "bundle.json"), "utf8"));
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    for (const base of [path.join(source, "runtime"), path.join(repo, "runtime")]) {
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(base, file), "utf8").replace(/\r\n/g, "\n")).digest("hex"), expected, file);
    }
  }
  for (const [file, expected] of Object.entries(manifest.packageSha256 || {})) {
    for (const base of [source, repo]) {
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(base, file), "utf8").replace(/\r\n/g, "\n")).digest("hex"), expected, file);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(source, path.join(dir, "plugin"), { recursive: true });
  const result = spawnSync(process.execPath, ["runtime/chat-control.mjs", "health"], { cwd: path.join(dir, "plugin"), encoding: "utf8", env: { ...process.env, TFO_DATA_DIR: path.join(dir, "data") }, timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "1.0.0-rc.1");
  assert.equal(fs.existsSync(path.join(source, "plugin.json")), false, "root portable manifest suppresses the local hook loader");
  const portable = JSON.parse(fs.readFileSync(path.join(source, "plugin.portable.json"), "utf8"));
  const legacy = JSON.parse(fs.readFileSync(path.join(source, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(portable.version, legacy.version);
  assert.equal(manifest.version, legacy.version);
  assert.equal(portable.skills, undefined);
  assert.equal(portable.extensions["com.openai"].hooks, "./hooks/hooks.json");
  assert.deepEqual(portable.extensions["com.openai"].interface.defaultPrompt, legacy.interface.defaultPrompt);
});
