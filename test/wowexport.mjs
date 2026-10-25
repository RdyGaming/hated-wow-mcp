/**
 * Tests for the ported wow.export code: BLTE parsing, CASC root parsing, and
 * (when a WoW install and the synced data exist) one real export.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const lib = fileURLToPath(new URL("../dist/wowexport/lib/", import.meta.url));
const BufferWrapper = require(join(lib, "buffer.js"));
const { BLTEReader } = require(join(lib, "casc", "blte-reader.js"));
const CASC = require(join(lib, "casc", "casc-source.js"));

let failed = 0;
async function verify(label, fn) {
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${label}\n        ${err.message.split("\n")[0]}`);
  }
}
const md5 = (b) => createHash("md5").update(b).digest("hex");

console.log("\n== wow.export port ==");

await verify("BLTE: single normal block", () => {
  const payload = Buffer.from("hello wow");
  const raw = Buffer.concat([Buffer.from("BLTE"), Buffer.from([0, 0, 0, 0]), Buffer.from("N"), payload]);
  const r = new BLTEReader(new BufferWrapper(raw), md5(raw));
  r.processAllBlocks();
  assert.equal(r.readBuffer(payload.length).raw.toString(), "hello wow");
});

await verify("BLTE: framed zlib blocks decompress in order", () => {
  const parts = [Buffer.from("first block "), Buffer.from("second block")];
  const blocks = parts.map((p) => Buffer.concat([Buffer.from("Z"), deflateSync(p)]));
  const headerSize = 24 * blocks.length + 12;
  const header = Buffer.alloc(headerSize);
  header.write("BLTE", 0);
  header.writeInt32BE(headerSize, 4);
  header.writeUInt8(0x0f, 8);
  header.writeUIntBE(blocks.length, 9, 3);
  blocks.forEach((b, i) => {
    const o = 12 + i * 24;
    header.writeInt32BE(b.length, o);
    header.writeInt32BE(parts[i].length, o + 4);
    Buffer.from(md5(b), "hex").copy(header, o + 8);
  });
  const raw = Buffer.concat([header, ...blocks]);
  const r = new BLTEReader(new BufferWrapper(raw), md5(header));
  r.processAllBlocks();
  assert.equal(r.readBuffer(24).raw.toString(), "first block second block");
});

await verify("BLTE: a wrong header hash is rejected", () => {
  const raw = Buffer.concat([Buffer.from("BLTE"), Buffer.from([0, 0, 0, 0]), Buffer.from("N"), Buffer.from("x")]);
  assert.throws(() => new BLTEReader(new BufferWrapper(raw), "0".repeat(32)), /Invalid MD5/);
});

await verify("BLTE: bad magic is rejected", () => {
  const raw = Buffer.from("NOPE\0\0\0\0Nxxxx");
  assert.throws(() => new BLTEReader(new BufferWrapper(raw), md5(raw)), /Invalid magic/);
});

await verify("CASC root: modern layout maps FileDataIDs to content keys", async () => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const keyA = Buffer.alloc(16, 0xaa);
  const keyB = Buffer.alloc(16, 0xbb);
  const body = Buffer.concat([
    u32(0x4d465354), u32(0x18), u32(1), u32(2), u32(2),
    Buffer.alloc(0x18 - 20),
    u32(2), u32(0), u32(2), // 2 records, content flags 0, locale enUS
    i32(100), i32(4), // ids 100 and 105 (delta encoded)
    keyA, keyB,
    Buffer.alloc(16), // name hashes
  ]);
  const raw = Buffer.concat([Buffer.from("BLTE"), Buffer.from([0, 0, 0, 0]), Buffer.from("N"), body]);
  const casc = new CASC(false);
  const count = await casc.parseRootFile(new BufferWrapper(raw), md5(raw));
  assert.equal(count, 2);
  assert.ok(casc.fileExists(100));
  assert.ok(casc.fileExists(105));
  assert.equal(casc.rootEntries.get(100).get(0), "aa".repeat(16));
});

// ---------------------------------------------------------------------------
// One real export, only where the install and synced data are present.
// ---------------------------------------------------------------------------

const { findInstallations } = await import("../dist/config.js");
const { setupProblem } = await import("../dist/wowexport/index.js");
const { ALL_TOOLS } = await import("../dist/server.js");

if (findInstallations().length === 0 || setupProblem() !== null) {
  console.log("  skip  real export (no WoW install, or game-data/model-data not synced)");
} else {
  await verify("real export: Deathwing M2 becomes glTF with animations", async () => {
    const out = mkdtempSync(join(tmpdir(), "wowexport-test-"));
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "wow_model_export");
      const res = await tool.handler({ model: "creature/deathwing/deathwing.m2", outputDir: out });
      assert.ok(!res.isError, res.content[0].text);
      const gltf = join(out, "creature", "deathwing", "deathwing.gltf");
      assert.ok(existsSync(gltf), "gltf not written");
      const json = JSON.parse(readFileSync(gltf, "utf8"));
      assert.ok(json.animations.length > 10, `only ${json.animations.length} animations`);
      assert.ok(json.images.length > 0, "no textures");
      for (const img of json.images) {
        assert.ok(existsSync(join(out, "creature", "deathwing", img.uri)), `missing ${img.uri}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

console.log(failed ? `\n${failed} failed\n` : "\nwow.export port: all passed\n");
process.exit(failed ? 1 : 0);
