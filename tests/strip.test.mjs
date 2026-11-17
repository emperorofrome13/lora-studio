import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripImage } from '../public/js/strip-core.js';
import { readImageMetadata } from '../public/js/meta.js';
import { saveImage, safeName } from '../lib/save.mjs';

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const has = (big, small) => Buffer.from(big).indexOf(Buffer.from(small)) >= 0;

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([1, 2, 3, 4])]);
}
const IDAT = Buffer.from('fake-compressed-pixels-0123456789');
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', Buffer.alloc(13, 1)),
  pngChunk('tEXt', Buffer.from('prompt\0{"3":{"class_type":"KSampler"}}', 'latin1')),
  pngChunk('iCCP', Buffer.from('icc\0\0xx', 'latin1')),
  pngChunk('tIME', Buffer.alloc(7)),
  pngChunk('IDAT', IDAT),
  pngChunk('IEND', Buffer.alloc(0)),
  Buffer.from('SECRET-TRAILER'),
]);

test('PNG: text, profile, timestamp and trailing data removed; image chunks byte-identical', async () => {
  const r = stripImage(png);
  assert.equal(r.format, 'png');
  assert.deepEqual(r.removed, ['text "prompt"', 'color profile (iCCP)', 'timestamp (tIME)', '14 bytes hidden after the image']);
  assert.ok(has(r.bytes, pngChunk('IDAT', IDAT)), 'IDAT copied verbatim incl. CRC');
  assert.ok(!has(r.bytes, Buffer.from('KSampler')) && !has(r.bytes, Buffer.from('SECRET')));
  assert.equal((await readImageMetadata(ab(Buffer.from(r.bytes)))).fields.length, 0);
  assert.ok(has(stripImage(png, { keepColor: true }).bytes, Buffer.from('iCCP')), 'keepColor keeps the profile');
});

function seg(marker, payload) {
  const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
// EXIF with Orientation = 6
const tiff = Buffer.alloc(26); tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(6, 18);
const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]); // stuffed byte + restart marker inside scan data
const jpg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
  seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret prompt</x:xmpmeta>', 'latin1')),
  seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1')),
  seg(0xfe, Buffer.from('made with secret settings')),
  seg(0xdb, Buffer.alloc(65, 2)),
  seg(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])),
  seg(0xc4, Buffer.alloc(20, 3)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  scan,
  Buffer.from([0xff, 0xd9]),
  Buffer.from('ZIP-AFTER-EOI'),
]);

test('JPEG: EXIF, XMP, JFIF, comment and trailing data removed; scan data and tables kept', async () => {
  const r = stripImage(jpg);
  assert.deepEqual(r.removed, ['JFIF header', 'EXIF', 'XMP', 'comment', '13 bytes hidden after the image']);
  assert.equal(r.warnings.length, 1, 'rotation warning');
  assert.ok(has(r.bytes, Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), scan, Buffer.from([0xff, 0xd9])])));
  assert.ok(has(r.bytes, Buffer.from('Adobe')), 'Adobe color-transform block kept');
  assert.ok(!has(r.bytes, Buffer.from('secret')) && !has(r.bytes, Buffer.from('ZIP')));
  assert.equal((await readImageMetadata(ab(Buffer.from(r.bytes)))).fields.length, 0);
});

function riffChunk(type, data) {
  const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
const vp8x = Buffer.alloc(10); vp8x[0] = 0x20 | 0x08 | 0x04 | 0x10; // ICC + EXIF + XMP + alpha
const frame = Buffer.from('VP8L-bitstream-odd');
const body = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('ICCP', Buffer.from('icc')), riffChunk('VP8L', frame),
  riffChunk('EXIF', Buffer.from('MM\0*secret')), riffChunk('XMP ', Buffer.from('<x:xmpmeta>secret</x:xmpmeta>'))]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body]);
webp.writeUInt32LE(4 + body.length, 4);

test('WebP: EXIF/XMP/ICC chunks removed, VP8X flags and RIFF size fixed', async () => {
  const r = stripImage(webp);
  assert.deepEqual(r.removed, ['color profile (ICC)', 'EXIF', 'XMP']);
  const out = Buffer.from(r.bytes);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out[20], 0x10, 'only the alpha flag remains');
  assert.ok(has(out, riffChunk('VP8L', frame)));
  assert.ok(!has(out, Buffer.from('secret')));
  assert.equal((await readImageMetadata(ab(out))).fields.length, 0);
});

test('unknown formats are refused (the app re-encodes those instead)', () => {
  assert.throws(() => stripImage(Buffer.from('GIF89a....')), (e) => e.unsupported === true);
});

test('saving never overwrites and only accepts real images with a full path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strip-'));
  const out = path.join(dir, 'clean', 'nested');
  const clean = Buffer.from(stripImage(png).bytes);
  const a = await saveImage(out, 'pic.png', clean);
  const b = await saveImage(out, 'pic.png', clean);
  assert.equal(path.basename(a), 'pic.png');
  assert.equal(path.basename(b), 'pic (1).png');
  assert.deepEqual(await fs.readFile(a), clean);
  await assert.rejects(saveImage('relative\\dir', 'x.png', clean), /full folder path/);
  await assert.rejects(saveImage(out, 'x.exe', clean), /Only \.png/);
  await assert.rejects(saveImage(out, 'x.jpg', clean), /not a valid image/);
  assert.equal(safeName('..\\..\\Windows\\evil.png'), 'evil.png');
  assert.equal(safeName('con.png'), '_con.png');
  assert.equal(safeName('a:b?.webp'), 'a_b_.webp');
});
