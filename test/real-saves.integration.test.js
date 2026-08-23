'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const sf = require('../lib/save-format');

// These tests only run when pointed at real save data:
//   DSTS_PC_DIR=/path/to/pc/saves DSTS_SWITCH_ZIP=/path/to/jksv-backup.zip npm test
const PC_DIR = process.env.DSTS_PC_DIR;
const SWITCH_ZIP = process.env.DSTS_SWITCH_ZIP;

// Zero the regions the conversion legitimately rewrites, so the rest can be compared.
function masked(body) {
  const b = Buffer.from(body);
  // The 4 bytes just past the end of the PC struct have no Switch counterpart.
  b.fill(0, sf.OUTFIT_STRUCT_START + sf.OUTFIT_STRUCT_SIZE,
    sf.OUTFIT_STRUCT_START + sf.OUTFIT_STRUCT_SIZE + 4);
  b.fill(0, sf.MODEL_DATA_START, sf.MODEL_DATA_START + sf.MODEL_DATA_SIZE);
  b.fill(0, sf.APPEARANCE_BLOCK_START, sf.APPEARANCE_BLOCK_START + sf.APPEARANCE_BLOCK_SIZE);
  return b;
}

// Starting from the Switch layout there is one extra by-design loss: the 4-byte
// gap that precedes the struct on Switch is overwritten when switch->pc shifts
// the struct down onto it, so a switch->pc->switch roundtrip cannot bring it
// back. Mask it rather than let it read as an unexplained failure.
function maskedFromSwitch(body) {
  const b = masked(body);
  b.fill(0, sf.SWITCH_STRUCT_START - 4, sf.SWITCH_STRUCT_START);
  return b;
}

test('real PC saves: pc->switch->pc preserves the data', { skip: !PC_DIR }, () => {
  const files = fs.readdirSync(PC_DIR).filter(f => /^\d{4}\.bin$/.test(f));
  assert.ok(files.length > 0, 'no NNNN.bin files in DSTS_PC_DIR');
  for (const f of files) {
    const pcFile = fs.readFileSync(path.join(PC_DIR, f));
    const sw = sf.pcToSwitch(pcFile);
    const back = sf.switchToPc(sw);

    const origPlain = sf.decryptPc(pcFile);
    const backPlain = sf.decryptPc(back);
    assert.deepStrictEqual(backPlain.subarray(0, sf.HEADER_SIZE),
      origPlain.subarray(0, sf.HEADER_SIZE), `${f}: header changed`);
    assert.deepStrictEqual(masked(backPlain.subarray(sf.HEADER_SIZE)),
      masked(origPlain.subarray(sf.HEADER_SIZE)),
      `${f}: body diverged outside the expected regions`);
    // Gender is preserved.
    assert.strictEqual(backPlain[sf.HEADER_SIZE + sf.GENDER_OFFSET],
      origPlain[sf.HEADER_SIZE + sf.GENDER_OFFSET], `${f}: gender changed`);
    // Gender moved to the right slot in the Switch layout (0x0FDC54).
    const swBody = sf.decompressBody(sw.subarray(sf.HEADER_SIZE));
    assert.strictEqual(swBody[sf.GENDER_OFFSET + 4],
      origPlain[sf.HEADER_SIZE + sf.GENDER_OFFSET],
      `${f}: gender did not move to the Switch slot`);
  }
});

test('real Switch backup: switch->pc->switch preserves the data', { skip: !SWITCH_ZIP }, () => {
  const zip = new AdmZip(SWITCH_ZIP);
  const entries = zip.getEntries().filter(e => /(^|\/)\d{4}\.bin$/.test(e.entryName));
  assert.ok(entries.length > 0, 'no NNNN.bin entries in DSTS_SWITCH_ZIP');
  for (const e of entries) {
    const swFile = e.getData();
    const pc = sf.switchToPc(swFile);
    const back = sf.pcToSwitch(pc);

    const origBody = sf.decompressBody(swFile.subarray(sf.HEADER_SIZE));
    const backBody = sf.decompressBody(back.subarray(sf.HEADER_SIZE));
    assert.deepStrictEqual(back.subarray(0, sf.HEADER_SIZE),
      swFile.subarray(0, sf.HEADER_SIZE), `${e.entryName}: header changed`);
    assert.deepStrictEqual(maskedFromSwitch(backBody), maskedFromSwitch(origBody),
      `${e.entryName}: body diverged outside the expected regions`);
  }
});
