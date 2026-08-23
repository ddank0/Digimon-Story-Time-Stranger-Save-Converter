'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sf = require('../lib/save-format');

function makeSwitchHeader() {
  // Real headers are CSV text in this shape; only field 1 (the body size) is validated.
  const text = '5, 3097152, 176, 0, Test , 1.000000, 100, 101, ' +
    '{ 0, 0, 0 }, {0, 0, 0 }, 0, 2026, 8, 23, 0, 0, 0, {194542}';
  const header = Buffer.alloc(sf.HEADER_SIZE);
  header.write(text, 0, 'latin1');
  return header;
}

test('format constants', () => {
  assert.strictEqual(sf.HEADER_SIZE, 1024);
  assert.strictEqual(sf.BODY_SIZE, 3097152);
  assert.strictEqual(sf.PC_SAVE_SIZE, 3098176);
});

test('encryptPc/decryptPc: roundtrip restores the bytes', () => {
  const plain = Buffer.alloc(sf.PC_SAVE_SIZE);
  for (let i = 0; i < plain.length; i += 997) plain[i] = i & 0xff;
  const enc = sf.encryptPc(plain);
  assert.strictEqual(enc.length, sf.PC_SAVE_SIZE);
  assert.notDeepStrictEqual(enc.subarray(0, 64), plain.subarray(0, 64));
  assert.deepStrictEqual(sf.decryptPc(enc), plain);
});

test('decryptPc rejects a wrong size', () => {
  assert.throws(() => sf.decryptPc(Buffer.alloc(100)), /3098176/);
});

test('compressBody/decompressBody: roundtrip restores the bytes', () => {
  const body = Buffer.alloc(sf.BODY_SIZE);
  for (let i = 0; i < body.length; i += 313) body[i] = (i * 7) & 0xff;
  const compressed = sf.compressBody(body);
  assert.ok(compressed.length > 0 && compressed.length < sf.BODY_SIZE);
  assert.deepStrictEqual(sf.decompressBody(compressed), body);
});

test('decompressBody rejects a payload that does not expand to BODY_SIZE', () => {
  // A valid LZ4 block, but from a body smaller than BODY_SIZE.
  const small = Buffer.alloc(1024, 7);
  const lz4 = require('lz4js');
  const dst = new Uint8Array(lz4.compressBound(small.length));
  const n = lz4.compressBlock(small, dst, 0, small.length, new Uint32Array(1 << 16));
  assert.throws(() => sf.decompressBody(Buffer.from(dst.buffer, 0, n)), /3097152/);
});

test('validateSwitchHeader accepts a real header and rejects garbage', () => {
  assert.doesNotThrow(() => sf.validateSwitchHeader(makeSwitchHeader()));
  const bad = Buffer.alloc(sf.HEADER_SIZE);
  bad.write('5, 999, 176', 0, 'latin1');
  assert.throws(() => sf.validateSwitchHeader(bad), /invalid Switch header/);
});

// Synthetic body: a recognizable pattern in the outfit struct, markers in the
// model regions, and a valid gender byte. The last 4 bytes of the struct are
// left at 0 for the roundtrip test, because the PC->Switch shift writes 4 bytes
// past the original end of the struct.
function makeTestBody() {
  const body = Buffer.alloc(sf.BODY_SIZE);
  for (let i = 0; i < body.length; i += 4096) body[i] = (i / 4096) & 0xff;
  for (let i = 0; i < sf.OUTFIT_STRUCT_SIZE - 4; i++) {
    body[sf.OUTFIT_STRUCT_START + i] = (i % 250) + 1;
  }
  // Layout marker (Switch 0x0FDC50 = PC struct+60): 1 in real saves.
  body[sf.OUTFIT_STRUCT_START + 60] = 1;
  // The variable gender field (PC 0x0FDC50 = Switch 0x0FDC54) is kept distinct
  // from the marker so any stray post-shift write-back is caught.
  body[sf.GENDER_OFFSET] = 0;
  body.fill(0xee, sf.MODEL_DATA_START, sf.MODEL_DATA_START + sf.MODEL_DATA_SIZE);
  body.fill(0xdd, sf.APPEARANCE_BLOCK_START, sf.APPEARANCE_BLOCK_START + sf.APPEARANCE_BLOCK_SIZE);
  return body;
}

test('convertBody pc-to-switch: shifts the struct +4, zeroes gap and model regions, keeps gender', () => {
  const original = makeTestBody();
  const body = Buffer.from(original);
  sf.convertBody(body, 'pc-to-switch');

  // The 4-byte gap at the original start of the struct is zeroed.
  assert.deepStrictEqual(
    body.subarray(sf.OUTFIT_STRUCT_START, sf.OUTFIT_STRUCT_START + 4),
    Buffer.alloc(4));
  // The whole struct moved +4, with no byte rewritten after the shift.
  for (let i = 0; i < sf.OUTFIT_STRUCT_SIZE; i++) {
    assert.strictEqual(body[sf.OUTFIT_STRUCT_START + 4 + i],
      original[sf.OUTFIT_STRUCT_START + i],
      `struct byte ${i} was not shifted`);
  }
  // Model regions are zeroed.
  assert.deepStrictEqual(
    body.subarray(sf.MODEL_DATA_START, sf.MODEL_DATA_START + sf.MODEL_DATA_SIZE),
    Buffer.alloc(sf.MODEL_DATA_SIZE));
  assert.deepStrictEqual(
    body.subarray(sf.APPEARANCE_BLOCK_START, sf.APPEARANCE_BLOCK_START + sf.APPEARANCE_BLOCK_SIZE),
    Buffer.alloc(sf.APPEARANCE_BLOCK_SIZE));
  // The layout marker arrives through the shift, not a rewrite.
  assert.strictEqual(body[sf.GENDER_OFFSET], 1);
  // The gender field lands in its Switch slot.
  assert.strictEqual(body[sf.GENDER_OFFSET + 4], 0);
  // Bytes outside the touched regions are untouched.
  assert.strictEqual(body[0], original[0]);
  assert.strictEqual(body[sf.BODY_SIZE - 4096], original[sf.BODY_SIZE - 4096]);
});

test('convertBody: pc->switch->pc roundtrip restores the body except the zeroed regions', () => {
  const original = makeTestBody();
  const body = Buffer.from(original);
  sf.convertBody(body, 'pc-to-switch');
  sf.convertBody(body, 'switch-to-pc');

  const expected = Buffer.from(original);
  expected.fill(0, sf.MODEL_DATA_START, sf.MODEL_DATA_START + sf.MODEL_DATA_SIZE);
  expected.fill(0, sf.APPEARANCE_BLOCK_START, sf.APPEARANCE_BLOCK_START + sf.APPEARANCE_BLOCK_SIZE);
  assert.deepStrictEqual(body, expected);
});

test('convertBody rejects an invalid layout marker', () => {
  const body = makeTestBody();
  body[sf.OUTFIT_STRUCT_START + 60] = 65;
  assert.throws(() => sf.convertBody(body, 'pc-to-switch'), /marker/);

  const body2 = makeTestBody();
  body2[sf.GENDER_OFFSET] = 65;
  assert.throws(() => sf.convertBody(body2, 'switch-to-pc'), /marker/);
});

function makePcFile() {
  const header = makeSwitchHeader(); // Both platforms use the same header format.
  return sf.encryptPc(Buffer.concat([header, makeTestBody()]));
}

test('pcToSwitch: emits a text header plus a valid LZ4 payload with the transformed body', () => {
  const out = sf.pcToSwitch(makePcFile());
  // The header is preserved byte for byte and stays readable.
  assert.deepStrictEqual(out.subarray(0, sf.HEADER_SIZE), makeSwitchHeader());
  // The payload decompresses to BODY_SIZE.
  const body = sf.decompressBody(out.subarray(sf.HEADER_SIZE));
  // The transform was applied: gap zeroed and gender in its canonical slot.
  assert.deepStrictEqual(
    body.subarray(sf.OUTFIT_STRUCT_START, sf.OUTFIT_STRUCT_START + 4),
    Buffer.alloc(4));
  assert.strictEqual(body[sf.GENDER_OFFSET], 1);
});

test('switchToPc(pcToSwitch(x)): roundtrip preserves everything but the zeroed regions', () => {
  const pcFile = makePcFile();
  const back = sf.switchToPc(sf.pcToSwitch(pcFile));
  assert.strictEqual(back.length, sf.PC_SAVE_SIZE);

  const originalPlain = sf.decryptPc(pcFile);
  const backPlain = sf.decryptPc(back);
  // Headers are identical.
  assert.deepStrictEqual(backPlain.subarray(0, sf.HEADER_SIZE),
    originalPlain.subarray(0, sf.HEADER_SIZE));
  // Bodies are identical once the model regions are zeroed in the original.
  const expectedBody = Buffer.from(originalPlain.subarray(sf.HEADER_SIZE));
  expectedBody.fill(0, sf.MODEL_DATA_START, sf.MODEL_DATA_START + sf.MODEL_DATA_SIZE);
  expectedBody.fill(0, sf.APPEARANCE_BLOCK_START, sf.APPEARANCE_BLOCK_START + sf.APPEARANCE_BLOCK_SIZE);
  assert.deepStrictEqual(backPlain.subarray(sf.HEADER_SIZE), expectedBody);
});

test('switchToPc validates the header and the minimum size', () => {
  assert.throws(() => sf.switchToPc(Buffer.alloc(100)), /too short/);
  const badHeader = Buffer.alloc(sf.HEADER_SIZE + 10);
  badHeader.write('garbage', 0, 'latin1');
  assert.throws(() => sf.switchToPc(badHeader), /invalid Switch header/);
});
