import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeCommand,
  encodeFrames,
  parseFrames,
  parseBattery,
  parseVersion,
  parseHex,
  formatHex,
  encodeRcsp,
  parseRcsp,
  parseFramesStream,
  parseRcspStream,
  parseQcyBlocks,
  parseSysInfo,
  commandBytes,
  eqGains,
  EQ_PRESETS,
  VOCAL_EQ,
  buildEqParams,
  parseEqParams,
} from '../protocol.js';

test('single command frame', () => {
  assert.deepEqual([...encodeCommand(7, [0xff])], [0xff, 3, 7, 1, 0xff]);
  assert.deepEqual([...encodeCommand(12, [1])], [0xff, 3, 12, 1, 1]);
});

test('multi-command frame and round trip', () => {
  const frame = encodeFrames([
    { cmd: 12, payload: [1] },
    { cmd: 7, payload: [0xff] },
  ]);
  assert.deepEqual([...frame], [0xff, 6, 12, 1, 1, 7, 1, 0xff]);
  assert.deepEqual(parseFrames(frame), [
    { cmd: 12, payload: [1] },
    { cmd: 7, payload: [255] },
  ]);
});

test('parses concatenated snapshot frames', () => {
  const snapshot = Uint8Array.from([
    0xff, 3, 7, 1, 200,
    0xff, 5, 23, 3, 1, 2, 50,
    0xff, 2, 0xfe, 0,
  ]);
  assert.deepEqual(parseFrames(snapshot), [
    { cmd: 7, payload: [200] },
    { cmd: 23, payload: [1, 2, 50] },
    { cmd: 0xfe, payload: [] },
  ]);
});

test('rejects truncated and misaligned data', () => {
  assert.throws(() => parseFrames(Uint8Array.from([0xff, 9, 7, 1])));
  assert.throws(() => parseFrames(Uint8Array.from([0xff, 4, 7, 9, 1])));
  assert.throws(() => parseFrames(Uint8Array.from([0x00, 0, 0])));
});

test('battery bytes', () => {
  assert.deepEqual(parseBattery(Uint8Array.from([0xb2, 60, 0x5a])), {
    left: { level: 50, charging: true },
    right: { level: 60, charging: false },
    case: { level: 90, charging: false },
  });
});

test('version bytes', () => {
  assert.deepEqual(parseVersion(Uint8Array.from([1, 2, 3, 4, 5, 6])), {
    left: '1.2.3',
    right: '4.5.6',
  });
  assert.deepEqual(parseVersion(Uint8Array.from([1, 2, 3])), { left: '1.2.3', right: null });
});

test('hex helpers', () => {
  assert.equal(formatHex(Uint8Array.from([0xff, 3, 12])), 'FF 03 0C');
  assert.deepEqual([...parseHex('ff030c')], [0xff, 3, 12]);
  assert.deepEqual([...parseHex('0xFF, 0x03')], [0xff, 3]);
  assert.throws(() => parseHex('abc'));
});

// ---- Jieli RCSP, vectors captured from a QCY H3S ----

test('rcsp custom command frame matches captured write', () => {
  // QCY cmd 23 = ANC preset: 17 03 01 01 02
  const frame = encodeRcsp(255, [...commandBytes(23, [1, 1, 2])], 5);
  assert.equal(formatHex(frame), 'FE DC BA C0 FF 00 06 05 17 03 01 01 02 EF');
});

test('rcsp custom response parses captured notify', () => {
  const captured = parseHex('fe dc ba 00 ff 00 07 00 00 17 03 01 01 02 ef');
  assert.deepEqual(parseRcsp(captured), [
    { type: 0, opcode: 255, status: 0, sn: 0, payload: [0x17, 3, 1, 1, 2] },
  ]);
  assert.deepEqual(parseQcyBlocks(parseRcsp(captured)[0].payload), [
    { cmd: 0x17, payload: [1, 1, 2] },
  ]);
});

test('rcsp status-only ack', () => {
  const captured = parseHex('fe dc ba 00 ff 00 02 00 01 ef');
  assert.deepEqual(parseRcsp(captured), [
    { type: 0, opcode: 255, status: 0, sn: 1, payload: [] },
  ]);
});

test('rcsp ignores partial and garbage frames', () => {
  assert.deepEqual(parseRcsp(parseHex('fe dc ba 00 ff 00 07 00 00')).length, 0);
  assert.deepEqual(parseRcsp(parseHex('00 11 22')).length, 0);
});

test('sysinfo battery response', () => {
  const captured = parseHex('fe dc ba 00 07 00 06 00 00 ff 02 00 5f ef');
  const [frame] = parseRcsp(captured);
  const info = parseSysInfo(frame.payload);
  assert.equal(info.function, 0xff);
  assert.deepEqual(info.attrs, [{ type: 0, data: [0x5f] }]);
});

test('sysinfo request frame', () => {
  assert.equal(formatHex(encodeRcsp(7, [0xff, 0, 0, 0, 1], 0)), 'FE DC BA C0 07 00 06 00 FF 00 00 00 01 EF');
});

test('anc preset table covers panel values', () => {
  const bytes = parseHex('17 03 01 05 00');
  assert.deepEqual(parseQcyBlocks(bytes), [{ cmd: 0x17, payload: [1, 5, 0] }]);
});

// ---- fragmentation across BLE notifications ----

test('qcy frames split across notifications', () => {
  const frame = encodeFrames([{ cmd: 0x17, payload: [1, 5, 0] }]);
  const a = parseFramesStream(frame.subarray(0, 4));
  assert.equal(a.frames.length, 0);
  assert.equal(a.rest.length, 4);
  const b = parseFramesStream(Uint8Array.from([...a.rest, ...frame.subarray(4)]));
  assert.deepEqual(b.frames, [{ cmd: 0x17, payload: [1, 5, 0] }]);
  assert.equal(b.rest.length, 0);
});

test('qcy stream skips leading noise', () => {
  const frame = encodeFrames([{ cmd: 0x07, payload: [200] }]);
  const { frames } = parseFramesStream(Uint8Array.from([0x12, 0x34, ...frame]));
  assert.deepEqual(frames, [{ cmd: 0x07, payload: [200] }]);
});

test('rcsp frame split across notifications', () => {
  const frame = encodeRcsp(255, [0x17, 3, 1, 1, 2], 0);
  const a = parseRcspStream(frame.subarray(0, 9));
  assert.equal(a.frames.length, 0);
  assert.equal(a.rest.length, 9);
  const b = parseRcspStream(Uint8Array.from([...a.rest, ...frame.subarray(9)]));
  assert.equal(b.frames.length, 1);
  assert.deepEqual(b.frames[0].payload, [0x17, 3, 1, 1, 2]);
  assert.equal(b.rest.length, 0);
});

test('rcsp stream survives interleaved garbage', () => {
  const frame = encodeRcsp(7, [0xff, 0, 0, 0, 1], 3);
  const { frames } = parseRcspStream(Uint8Array.from([0x00, 0xff, 0xfe, 0xdc, ...frame]));
  assert.equal(frames.length, 1);
});

test('equalizer gains convert dB to signed byte', () => {
  assert.deepEqual([...eqGains([-2.5, 7, 0, 12.7, -20])], [0xe7, 70, 0, 127, 0x81]);
  assert.equal(eqGains(VOCAL_EQ.db).length, 10);
});

test('equalizer presets have ten bands', () => {
  for (const p of EQ_PRESETS) assert.equal(p.db.length, 10, p.name);
});

test('jieli equalizer write frame', () => {
  const gains = eqGains(VOCAL_EQ.db);
  const frame = encodeRcsp(8, [0xff, 12, 4, 0xff, ...gains], 0);
  assert.equal(
    formatHex(frame),
    'FE DC BA C0 08 00 0F 00 FF 0C 04 FF E2 D8 CE F6 1E 46 3C 1E 00 EC EF',
  );
});

test('parses captured equalizer payload', () => {
  const payload = parseHex(
    '01 70 fe 1e 00 00 00 50 00 00 aa 00 5c f9 3c 00 02 2c 01 38 ff c8 00 02 ' +
    'bc 02 c8 00 64 00 02 b0 04 3e fe c8 00 02 f0 0a 2c 01 64 00 02 88 13 d4 fe ' +
    'c8 00 02 10 27 a8 fd 2c 01 02 f8 2a c8 00 c8 00 03 5f 54 00 00 46 00 02'
  );
  const eq = parseEqParams(payload);
  assert.equal(eq.type, 1);
  assert.equal(eq.master, -4);
  assert.equal(eq.bands.length, 10);
  assert.deepEqual(eq.bands[0], { freq: 30, gain: 0, q: 0.8, type: 0 });
  assert.equal(eq.bands[1].gain, -17);
});

test('builds equalizer payload matching the device write', () => {
  const pop = EQ_PRESETS.find((p) => p.name === 'Pop');
  const payload = buildEqParams(3, -4, pop.db);
  assert.equal(payload.length, 73);
  assert.equal(formatHex(payload),
    '03 70 FE 20 00 00 00 28 00 02 40 00 5C F9 78 00 02 7D 00 38 FF 96 00 02 ' +
    'FA 00 C8 00 96 00 02 F4 01 06 FF 78 00 02 E8 03 90 01 50 00 02 D0 07 00 00 ' +
    '78 00 02 A0 0F A8 FD 78 00 02 40 1F C8 00 78 00 02 80 3E 00 00 78 00 02');
});
