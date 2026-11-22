// Protocols recovered from QCY 4.0.7.
//
// Two transports are supported:
//
// 1) QCY native BLE service 0xA001
//      write 00001001  framed commands (with response)
//      notify/read 00001002
//      read 00000007 firmware, 00000008 battery, 0000000B EQ, 0000000D keys
//    Frame: FF <len> { <cmd> <plen> <payload…> } …
//
// 2) Jieli RCSP BLE service 0xA002 (QCY H3S and other Jieli models)
//      write 00000001, notify 00000002
//    Frame: FE DC BA <flags> <op> <len_hi> <len_lo> <sn> <payload…> EF
//    The QCY command blocks above are tunnelled as RCSP custom commands
//    (op 255): payload is plain <cmd> <plen> <payload…> without the FF frame.
//    Battery is read with RCSP GetSysInfo (op 7, mask 1).

export const SERVICE_UUID = '0000a001-0000-1000-8000-00805f9b34fb';
export const JL_SERVICE_UUID = '0000a002-0000-1000-8000-00805f9b34fb';

// QCY H3S (and similar Jieli models) advertise an unnamed LE control link with
// service 0xFEE8 and manufacturer data id 0x521C. Chrome's chooser otherwise
// offers the named classic/BR-EDR entry, which has no GATT services.
export const ADVERTISED_SERVICE_UUID = '0000fee8-0000-1000-8000-00805f9b34fb';
export const QCY_MANUFACTURER_ID = 0x521c;

export const CHAR = {
  version: '00000007-0000-1000-8000-00805f9b34fb',
  battery: '00000008-0000-1000-8000-00805f9b34fb',
  eq: '0000000b-0000-1000-8000-00805f9b34fb',
  keyFunction: '0000000d-0000-1000-8000-00805f9b34fb',
  write: '00001001-0000-1000-8000-00805f9b34fb',
  notify: '00001002-0000-1000-8000-00805f9b34fb',
};

export const JL_CHAR = {
  write: '00000001-0000-1000-8000-00805f9b34fb',
  notify: '00000002-0000-1000-8000-00805f9b34fb',
};

// Command ids from com.qcymall.qcylibrary.dataBean.DataBean.
export const CMD = {
  noise: 0x07,
  noiseMode: 0x0c,
  ancSetting: 0x17,
  battery: 0x2f,
  version: 0x30,
  requestData: 0xfe,
};

export const NOISE_MODE = { off: 0, anc: 1, transparency: 2 };

// ANC presets shipped in QCY's H3S control panel (cmd 23 payloads).
export const ANC_PRESETS = [
  { key: 'normal', label: 'Off (normal)', bytes: [2, 0, 0] },
  { key: 'adaptive', label: 'Adaptive ANC', bytes: [1, 5, 0] },
  { key: 'noisy', label: 'Noisy (ANC)', bytes: [1, 1, 0], levels: 3 },
  { key: 'commuting', label: 'Commuting (ANC)', bytes: [1, 2, 0], levels: 3 },
  { key: 'indoor', label: 'Indoor (ANC)', bytes: [1, 3, 0], levels: 3 },
  { key: 'wind', label: 'Anti-wind', bytes: [1, 4, 0] },
  { key: 'transparency', label: 'Transparency', bytes: [3, 1, 4] },
];

// Equalizer: 10 bands, gains in dB*10 (signed byte), from the H3S control panel.
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_Q = [0.4, 1.2, 1.5, 1.5, 1.2, 0.8, 1.2, 1.2, 1.2, 1.2];
export const EQ_BAND_TYPE = 2;

export const EQ_PRESETS = [
  { id: 1, name: 'Spatial', db: [0, -3, -7, -13, 2, -5, 3, 2, -15, -4] },
  { id: 2, name: 'Default', db: [0, -17, -2, 2, -2.5, 3, -3, -6, 2, 0] },
  { id: 3, name: 'Pop', db: [0, -17, -2, 2, -2.5, 4, 0, -6, 2, 0] },
  { id: 4, name: 'Heavy Bass', db: [5, -17, -2, 2, -2.5, 0, -6, -6, 0, 0] },
  { id: 5, name: 'Rock', db: [3, -17, -2, 0, -2.5, 4, 0, -3, 2, 0] },
  { id: 6, name: 'Soft', db: [0, -17, -2, 2, -2.5, 0, -5, -6, 0, 0] },
  { id: 7, name: 'Classic', db: [0, -14, -2, 2, -2.5, 3, -3, -6, 2, 0] },
];

// Custom curve: cut rumble and mud, lift presence (1-4 kHz), tame sibilance.
export const VOCAL_EQ = { id: 240, name: 'Vocal boost', db: [-3, -4, -5, -1, 3, 7, 6, 3, 0, -2] };

/** Build a cmd 0x22 payload: [type][master gain][10 bands: freq, gain, Q, type]. */
export function buildEqParams(type, masterDb, db) {
  const out = [type & 0xff];
  const put16 = (v) => {
    const n = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
    out.push(n & 0xff, n >> 8);
  };
  put16(masterDb * 100);
  for (let i = 0; i < 10; i++) {
    put16(EQ_FREQS[i]);
    put16(db[i] * 100);
    put16(EQ_Q[i] * 100);
    out.push(EQ_BAND_TYPE);
  }
  return out;
}

/** Parse a cmd 0x22 payload as sent by the device. */
export function parseEqParams(bytes) {
  const data = Uint8Array.from(bytes);
  if (data.length < 3) return null;
  const s16 = (i) => {
    const raw = data[i] | (data[i + 1] << 8);
    return raw > 0x7fff ? raw - 0x10000 : raw;
  };
  const bands = [];
  for (let i = 3; i + 7 <= data.length; i += 7) {
    bands.push({
      freq: s16(i),
      gain: s16(i + 2) / 100,
      q: s16(i + 4) / 100,
      type: data[i + 6],
    });
  }
  return { type: data[0], master: s16(1) / 100, bands };
}

/** dB curve to signed gain bytes (dB * 10, clamped to +-127). */
export function eqGains(db) {
  return db.map((v) => Math.max(-127, Math.min(127, Math.round(v * 10))) & 0xff);
}

const SOF = 0xff;

/** One QCY command block, no frame envelope. */
export function commandBytes(cmd, payload = []) {
  return Uint8Array.from([cmd & 0xff, payload.length, ...payload.map((b) => b & 0xff)]);
}

/** Wrap QCY command blocks in one FF frame (service 0xA001). */
export function encodeFrames(blocks) {
  const body = blocks.flatMap(({ cmd, payload }) => [...commandBytes(cmd, payload)]);
  return Uint8Array.from([SOF, body.length, ...body]);
}

export function encodeCommand(cmd, payload = []) {
  return encodeFrames([{ cmd, payload }]);
}

/** Parse QCY FF frames into [{cmd, payload}]. Throws on malformed data. */
export function parseFrames(bytes) {
  const data = Uint8Array.from(bytes);
  const out = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== SOF) throw new Error(`expected 0xFF at ${i}, got 0x${data[i].toString(16)}`);
    const len = data[i + 1];
    const end = i + 2 + len;
    if (len === undefined || end > data.length) throw new Error('truncated frame');
    let j = i + 2;
    while (j < end) {
      const cmd = data[j];
      const plen = data[j + 1];
      j += 2;
      if (j + plen > end) throw new Error(`truncated payload for cmd ${cmd}`);
      out.push({ cmd, payload: [...data.subarray(j, j + plen)] });
      j += plen;
    }
    i = end;
  }
  return out;
}

/** Parse QCY frames, keeping an incomplete tail for the next notification. */
export function parseFramesStream(bytes) {
  const data = Uint8Array.from(bytes);
  const frames = [];
  let i = 0;
  while (i + 2 <= data.length) {
    if (data[i] !== SOF) {
      i++;
      continue;
    }
    const len = data[i + 1];
    const end = i + 2 + len;
    if (end > data.length) break;
    let j = i + 2;
    let ok = true;
    const blocks = [];
    while (j < end) {
      const cmd = data[j];
      const plen = data[j + 1];
      j += 2;
      if (j + plen > end) {
        ok = false;
        break;
      }
      blocks.push({ cmd, payload: [...data.subarray(j, j + plen)] });
      j += plen;
    }
    if (!ok) break;
    frames.push(...blocks);
    i = end;
  }
  return { frames, rest: data.subarray(i) };
}

/** Parse RCSP frames, keeping an incomplete tail for the next notification. */
export function parseRcspStream(bytes) {
  const data = Uint8Array.from(bytes);
  const frames = [];
  let i = 0;
  while (i + 3 <= data.length) {
    if (data[i] !== 0xfe || data[i + 1] !== 0xdc || data[i + 2] !== 0xba) {
      i++;
      continue;
    }
    if (i + 8 > data.length) break;
    const flags = data[i + 3];
    const opcode = data[i + 4];
    const len = (data[i + 5] << 8) | data[i + 6];
    const end = i + 7 + len;
    if (end + 1 > data.length) break;
    if (data[end] !== 0xef) {
      i++;
      continue;
    }
    const body = data.subarray(i + 7, end);
    const type = (flags >> 7) & 1;
    if (type) frames.push({ type, opcode, sn: body[0], payload: [...body.subarray(1)] });
    else frames.push({ type, opcode, status: body[0], sn: body[1], payload: [...body.subarray(2)] });
    i = end + 1;
  }
  return { frames, rest: data.subarray(i) };
}

/** Parse bare QCY blocks (cmd/len/data) used inside RCSP custom commands. */
export function parseQcyBlocks(bytes) {
  const out = [];
  let i = 0;
  const data = Uint8Array.from(bytes);
  while (i + 2 <= data.length) {
    const cmd = data[i];
    const len = data[i + 1];
    if (i + 2 + len > data.length) break;
    out.push({ cmd, payload: [...data.subarray(i + 2, i + 2 + len)] });
    i += 2 + len;
  }
  return out;
}

/** RCSP frame (single command, expects a response). */
export function encodeRcsp(opcode, payload = [], sn = 0) {
  const body = [sn & 0xff, ...payload.map((b) => b & 0xff)];
  return Uint8Array.from([
    0xfe, 0xdc, 0xba, 0xc0, opcode & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff,
    ...body, 0xef,
  ]);
}

/** Parse concatenated RCSP frames; ignores partial trailing data. */
export function parseRcsp(bytes) {
  const data = Uint8Array.from(bytes);
  const out = [];
  let i = 0;
  while (i + 8 <= data.length) {
    if (data[i] !== 0xfe || data[i + 1] !== 0xdc || data[i + 2] !== 0xba) {
      i++;
      continue;
    }
    const flags = data[i + 3];
    const opcode = data[i + 4];
    const len = (data[i + 5] << 8) | data[i + 6];
    const end = i + 7 + len;
    if (end >= data.length || data[end] !== 0xef) {
      i++;
      continue;
    }
    const body = data.subarray(i + 7, end);
    const type = (flags >> 7) & 1;
    if (type) out.push({ type, opcode, sn: body[0], payload: [...body.subarray(1)] });
    else out.push({ type, opcode, status: body[0], sn: body[1], payload: [...body.subarray(2)] });
    i = end + 1;
  }
  return out;
}

/** GetSysInfo response: [function][len type data…] attributes. */
export function parseSysInfo(bytes) {
  const data = Uint8Array.from(bytes);
  const attrs = [];
  let i = 1;
  while (i + 2 <= data.length) {
    const len = data[i];
    const type = data[i + 1];
    if (len === 0 || i + 1 + len > data.length) break;
    attrs.push({ type, data: [...data.subarray(i + 2, i + 1 + len)] });
    i += 1 + len;
  }
  return { function: data[0], attrs };
}

/** Battery characteristic: [left, right, case]; bit 7 charging, bits 0-6 %. */
export function parseBattery(bytes) {
  const read = (i) =>
    i < bytes.length ? { level: bytes[i] & 0x7f, charging: (bytes[i] & 0x80) !== 0 } : null;
  return { left: read(0), right: read(1), case: read(2) };
}

/** Version characteristic: L major/minor/patch then R major/minor/patch. */
export function parseVersion(bytes) {
  const fmt = (i) => `${bytes[i]}.${bytes[i + 1]}.${bytes[i + 2]}`;
  return {
    left: bytes.length >= 3 ? fmt(0) : null,
    right: bytes.length >= 6 ? fmt(3) : null,
  };
}

export function formatHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function parseHex(text) {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('odd number of hex digits');
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return Uint8Array.from(out);
}
