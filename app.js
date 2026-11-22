import {
  SERVICE_UUID,
  JL_SERVICE_UUID,
  ADVERTISED_SERVICE_UUID,
  QCY_MANUFACTURER_ID,
  CHAR,
  JL_CHAR,
  NOISE_MODE,
  ANC_PRESETS,
  EQ_PRESETS,
  VOCAL_EQ,
  eqGains,
  buildEqParams,
  parseEqParams,
  encodeCommand,
  encodeFrames,
  commandBytes,
  parseFramesStream,
  parseRcspStream,
  parseQcyBlocks,
  parseSysInfo,
  parseBattery,
  parseVersion,
  formatHex,
  parseHex,
  encodeRcsp,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const SAVED_KEY = 'qcy.lastDeviceId';
const EQ_KEY = 'qcy.eq';
let eqSynced = false;
const state = { device: null, server: null, family: null, chars: new Map(), sn: 0, connected: false, anc: null, eq: null };
const rxPending = new Map();
let ancTimer = null;
let eqTimer = null;
const CYCLE_KEY = 'qcy.cycle';
const DEFAULT_CYCLE = ['2,0', '1,5', '1,3'];
let cycleSlots = [...DEFAULT_CYCLE];
let cycleCursor = -1;

function presetByKey(key) {
  return ANC_PRESETS.find((p) => `${p.bytes[0]},${p.bytes[1]}` === key);
}

function cycleList() {
  const seen = new Set();
  return cycleSlots.filter((key) => {
    if (!key || !presetByKey(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadCycle() {
  try {
    const raw = JSON.parse(localStorage.getItem(CYCLE_KEY) || 'null');
    if (Array.isArray(raw)) cycleSlots = [raw[0] || '', raw[1] || '', raw[2] || ''];
  } catch {}
  for (const select of document.querySelectorAll('#cycleEditor select')) {
    const slot = Number(select.dataset.slot);
    select.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(none)';
    select.append(none);
    for (const preset of ANC_PRESETS) {
      const option = document.createElement('option');
      option.value = `${preset.bytes[0]},${preset.bytes[1]}`;
      option.textContent = preset.label;
      select.append(option);
    }
    select.value = cycleSlots[slot] || '';
    select.addEventListener('change', () => {
      cycleSlots[slot] = select.value;
      try {
        localStorage.setItem(CYCLE_KEY, JSON.stringify(cycleSlots));
      } catch {}
      cycleCursor = -1;
      updateCycle();
    });
  }
}
let pendingAnc = null; // { acked, readSent }

function eqName(mode) {
  const preset = EQ_PRESETS.find((p) => p.id === mode);
  if (preset) return preset.name;
  if (mode === 240 || mode === 0x80 || mode === 0xff) return 'Vocal boost';
  return `mode ${mode}`;
}

function setEqStatus(text, kind = '') {
  const el = $('eqStatus');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function markEq(mode) {
  for (const b of document.querySelectorAll('[data-eq]')) {
    const want = Number(b.dataset.eq);
    b.classList.toggle('active', want === mode || (want === 240 && (mode === 240 || mode === 0xff || mode === 128)));
  }
  if (eqTimer) clearTimeout(eqTimer);
  eqTimer = null;
  setEqStatus(`applied: ${eqName(mode)}`, 'ok');
}

function handleEqParams(payload) {
  const parsed = parseEqParams(payload);
  if (!parsed) return;
  state.eq = parsed;
  markEq(parsed.type);
  if (!eqSynced) {
    eqSynced = true;
    syncSavedEq();
  }
}

function handleEq(bytes) {
  if (!bytes || !bytes.length) return;
  state.eq = { type: bytes[0], gains: [...bytes.slice(1)] };
  markEq(bytes[0]);
  if (!eqSynced) {
    eqSynced = true;
    syncSavedEq();
  }
}

async function readEq() {
  setEqStatus('reading equalizer…', 'busy');
  if (eqTimer) clearTimeout(eqTimer);
  eqTimer = setTimeout(() => {
    eqTimer = null;
    setEqStatus('device reports no equalizer state');
  }, 2500);
  try {
    if (state.family === 'jl') {
      await sendCommand(0xfe, [34]);
      return;
    }
    const c = state.chars.get(CHAR.eq);
    if (c && c.properties.read) {
      const v = await c.readValue();
      handleEq(new Uint8Array(v.buffer));
      return;
    }
    log('sys', 'equalizer characteristic is not readable');
  } catch (e) {
    setEqStatus(`equalizer read failed: ${e.message}`, 'err');
  }
}

function savedEq() {
  const value = Number(localStorage.getItem(EQ_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function syncSavedEq() {
  const saved = savedEq();
  if (!saved || !state.eq || state.eq.type === saved) return;
  log('sys', `applying saved equalizer ${eqName(saved)}`);
  await applyEq(saved);
}

async function applyEq(mode) {
  const preset = EQ_PRESETS.find((p) => p.id === mode);
  const db = preset ? preset.db : VOCAL_EQ.db;
  const gains = eqGains(db);
  try {
    localStorage.setItem(EQ_KEY, String(preset ? mode : VOCAL_EQ.id));
  } catch {}
  setEqStatus(`sending ${preset ? preset.name : VOCAL_EQ.name}…`, 'busy');
  if (eqTimer) clearTimeout(eqTimer);
  eqTimer = setTimeout(() => {
    eqTimer = null;
    setEqStatus('no confirmation from the device', 'err');
  }, 3000);
  try {
    if (state.family === 'jl') {
      const type = preset ? mode : VOCAL_EQ.id;
      const master = state.eq ? state.eq.master : -4;
      await sendCommand(34, buildEqParams(type, master, db));
    } else {
      const type = preset ? mode : 128;
      await writeRaw(CHAR.eq, Uint8Array.from([type, ...gains]));
    }
    const expected = state.family === 'jl' ? (preset ? mode : VOCAL_EQ.id) : preset ? mode : 128;
    setTimeout(() => readEq(), 500);
    setTimeout(() => {
      if (!state.eq || state.eq.type !== expected) readEq();
    }, 1800);
  } catch (e) {
    if (eqTimer) clearTimeout(eqTimer);
    eqTimer = null;
    setEqStatus(`send failed: ${e.message}`, 'err');
  }
}

function presetName(mode, scene) {
  const p = ANC_PRESETS.find((x) => x.bytes[0] === mode && x.bytes[1] === scene);
  return p ? p.label : `${mode}/${scene}`;
}

function cycleIndex() {
  const cur = state.anc;
  if (!cur) return -1;
  return cycleList().findIndex((key) => {
    const preset = presetByKey(key);
    return preset && preset.bytes[0] === cur.mode && preset.bytes[1] === cur.scene;
  });
}

function updateCycle() {
  const cur = state.anc;
  const list = cycleList();
  const idx = cycleIndex();
  const currentLabel = idx >= 0
    ? presetByKey(list[idx]).label
    : cur
      ? presetName(cur.mode, cur.scene)
      : '—';
  $('cycleAnc').textContent = `Noise: ${currentLabel}`;
  if (cycleCursor >= list.length) cycleCursor = -1;
  if (!state.connected) $('cycleNext').textContent = 'connect to enable noise control';
  else if (!list.length) $('cycleNext').textContent = 'choose at least one mode above';
  else {
    const next = presetByKey(list[(cycleCursor + 1) % list.length]);
    $('cycleNext').textContent = `click: switch to ${next.label}`;
  }
}

function setAncStatus(text, kind = '') {
  const el = $('ancStatus');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function log(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  const list = $('log');
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

function showError(text, allowPick) {
  $('connErrorText').textContent = text;
  $('connError').hidden = false;
  $('pickLe').hidden = !allowPick;
}

function clearError() {
  $('connError').hidden = true;
  $('pickLe').hidden = true;
}

function setControls() {
  const on = state.connected;
  for (const id of ['disconnect', 'readBattery', 'readVersion', 'checkFw', 'readAnc', 'readNoise', 'readSnapshot', 'sendRaw', 'sendAnc', 'cycleAnc'])
    $(id).disabled = !on;
  for (const b of document.querySelectorAll('[data-eq]')) b.disabled = !on;
  updateCycle();
  for (const b of document.querySelectorAll('[data-mode], [data-preset]')) b.disabled = !on;
  $('connect').disabled = on;
  $('state').textContent = on ? `connected (${state.family})` : 'disconnected';
  $('state').className = on ? 'pill ok' : 'pill off';
  $('familyRow').hidden = !on;
}

function resetReadout() {
  state.anc = null;
  updateCycle();
  if (ancTimer) clearTimeout(ancTimer);
  ancTimer = null;
  pendingAnc = null;
  setAncStatus('connect to enable noise control');
  setEqStatus('connect to read equalizer');
  $('fwStatus').textContent = '';
  for (const b of document.querySelectorAll('[data-eq].active')) b.classList.remove('active');
  $('battery').textContent = '—';
  $('version').textContent = '—';
  $('noiseMode').textContent = '—';
  $('noiseLevel').textContent = '—';
  $('ancLevel').hidden = true;
  for (const b of document.querySelectorAll('[data-preset].active')) b.classList.remove('active');
}

function onDisconnected() {
  log('sys', 'disconnected');
  state.connected = false;
  state.family = null;
  state.chars.clear();
  rxPending.clear();
  state.anc = null;
  state.eq = null;
  eqSynced = false;
  cycleCursor = -1;
  resetReadout();
  $('svc').textContent = 'not found';
  $('chars').textContent = '—';
  setControls();
}

async function connect() {
  if (!navigator.bluetooth) {
    showError('This browser has no Web Bluetooth. Launch Chromium with --enable-features=WebBluetooth.', false);
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'QCY' },
        { services: [ADVERTISED_SERVICE_UUID] },
        { manufacturerData: [{ companyIdentifier: QCY_MANUFACTURER_ID }] },
      ],
      optionalServices: [SERVICE_UUID, JL_SERVICE_UUID],
    });
    await connectDevice(device);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return; // user cancelled the chooser
    reportFailure(e);
  }
}

/** Escape hatch: list every BLE device, including ones that do not advertise a QCY signature. */
async function pickLe() {
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID, JL_SERVICE_UUID],
    });
    await connectDevice(device);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return;
    reportFailure(e);
  }
}

/** Reconnect a device the site already has permission for, without a chooser. */
async function reconnectSaved({ auto = false } = {}) {
  try {
    const devices = await navigator.bluetooth.getDevices();
    const last = localStorage.getItem(SAVED_KEY);
    if (last) devices.sort((a, b) => (a.id === last ? 0 : 1) - (b.id === last ? 0 : 1));
    log('sys', `saved devices: ${devices.length}${last ? `, last used ${last}` : ''}`);
    for (const device of devices) {
      log('sys', `trying saved ${device.name || '(unnamed)'} ${device.id}`);
      if (await connectDevice(device, { quiet: true })) return;
    }
    showError(
      auto
        ? 'Saved entry did not connect. If it is the classic one, press "Show all devices".'
        : 'No saved device answered. Press Connect, or "Show all devices".',
      true,
    );
  } catch (e) {
    log('err', `getDevices: ${e.message}`);
  }
}

async function connectDevice(device, { quiet = false } = {}) {
  clearError();
  state.device = device;
  rxPending.clear();
  cycleCursor = -1;
  resetReadout();
  $('name').textContent = device.name || '(unnamed)';
  log('sys', `picked ${device.name || '(unnamed)'} id=${device.id}`);
  device.addEventListener('gattserverdisconnected', onDisconnected);

  try {
    log('sys', 'connecting GATT…');
    const server = await device.gatt.connect();
    state.server = server;
    await setupFamily(server);

    state.connected = true;
    setAncStatus('ready');
    try {
      localStorage.setItem(SAVED_KEY, device.id);
    } catch {}
    setControls();
    await readBattery();
    await readVersion();
    await readAnc();
    eqSynced = false;
    await readEq();
    return true;
  } catch (e) {
    if (!quiet) reportFailure(e);
    else log('sys', `saved device failed: ${e.name || 'Error'}: ${e.message || e}`);
    try {
      device.gatt.disconnect();
    } catch {}
    return false;
  }
}

function reportFailure(e) {
  const name = e && e.name ? e.name : 'Error';
  const message = e && e.message ? e.message : String(e);
  log('err', `connect failed: ${name}: ${message}`);
  const classic = /no QCY service|classic|GATT Server is disconnected|NetworkError/i.test(`${name} ${message}`);
  showError(
    `${name}: ${message}` +
      (classic
        ? ' — this looks like the classic (BR/EDR) entry. Press "Show all devices" and choose the unnamed QCY entry.'
        : ''),
    true,
  );
}

async function setupFamily(server) {
  const services = await server.getPrimaryServices();
  const uuids = services.map((s) => s.uuid);
  log('sys', `services: ${uuids.join(', ') || '(none allowed)'}`);

  const qcy = services.find((s) => s.uuid === SERVICE_UUID);
  const jl = services.find((s) => s.uuid === JL_SERVICE_UUID);

  state.chars.clear();
  if (qcy) {
    state.family = 'qcy';
    $('svc').textContent = qcy.uuid;
    for (const c of await qcy.getCharacteristics()) state.chars.set(c.uuid, c);
  } else if (jl) {
    state.family = 'jl';
    $('svc').textContent = jl.uuid;
    for (const c of await jl.getCharacteristics()) state.chars.set(c.uuid, c);
  } else {
    throw new Error(`no QCY service found; device exposes ${uuids.join(', ') || 'none'}`);
  }
  $('chars').textContent = [...state.chars.keys()].map((u) => u.slice(0, 8)).join(' ');
  log('sys', `${state.family} family, characteristics: ${$('chars').textContent}`);
  await subscribeAll();
  $('family').textContent = state.family;
  const isQcy = state.family === 'qcy';
  $('qcyOnly').hidden = !isQcy;
  $('readNoise').hidden = !isQcy;
  $('readSnapshot').hidden = !isQcy;
  $('noiseLevelLabel').hidden = !isQcy;
  $('noiseLevel').hidden = !isQcy;
}

async function subscribeAll() {
  for (const c of state.chars.values()) {
    if (!c.properties.notify && !c.properties.indicate) continue;
    try {
      await c.startNotifications();
      c.addEventListener('characteristicvaluechanged', () =>
        handleNotify(c.uuid, new Uint8Array(c.value.buffer)),
      );
      log('sys', `subscribed ${c.uuid.slice(0, 8)}`);
    } catch (e) {
      log('err', `subscribe ${c.uuid.slice(0, 8)} failed: ${e.message}`);
    }
  }
}

async function writeRaw(uuid, bytes) {
  log('tx', `${uuid.slice(0, 8)}  ${formatHex(bytes)}`);
  const c = state.chars.get(uuid);
  if (!c) throw new Error(`characteristic ${uuid.slice(0, 8)} missing`);
  try {
    await c.writeValueWithResponse(bytes);
  } catch {
    await c.writeValueWithoutResponse(bytes);
  }
}

/** Send one QCY command through whichever transport the device uses. */
async function sendCommand(cmd, payload = []) {
  if (state.family === 'jl') {
    const body = [...commandBytes(cmd, payload)];
    await writeRaw(JL_CHAR.write, encodeRcsp(255, body, state.sn++ & 0xff));
  } else {
    await writeRaw(CHAR.write, encodeCommand(cmd, payload));
  }
}

async function sendRcsp(opcode, payload) {
  await writeRaw(JL_CHAR.write, encodeRcsp(opcode, payload, state.sn++ & 0xff));
}

async function readBattery() {
  try {
    if (state.family === 'jl') {
      await sendRcsp(7, [0xff, 0, 0, 0, 1]);
      return;
    }
    const c = state.chars.get(CHAR.battery);
    if (c && c.properties.read) {
      const v = await c.readValue();
      return showBattery(parseBattery(new Uint8Array(v.buffer)));
    }
    await sendCommand(0xfe, [0x2f]);
  } catch (e) {
    log('err', `battery: ${e.message}`);
  }
}

async function readVersion() {
  try {
    if (state.family === 'qcy') {
      const c = state.chars.get(CHAR.version);
      if (c && c.properties.read) {
        const v = await c.readValue();
        return showVersion(parseVersion(new Uint8Array(v.buffer)));
      }
    }
    await sendCommand(0xfe, [0x30]);
  } catch (e) {
    log('err', `version: ${e.message}`);
  }
}

async function readAnc() {
  setAncStatus('reading state…', 'busy');
  pendingAnc = { acked: true, readSent: true };
  if (ancTimer) clearTimeout(ancTimer);
  ancTimer = setTimeout(() => {
    ancTimer = null;
    if (pendingAnc) {
      pendingAnc = null;
      setAncStatus('no state report from the device', 'err');
    }
  }, 3000);
  try {
    await sendCommand(0xfe, [0x17]);
  } catch (e) {
    setAncStatus(`read failed: ${e.message}`, 'err');
  }
}

/** QCY 0xA001 only: metric reported by command 0x07. */
async function checkFirmware() {
  $('fwStatus').className = 'status busy';
  $('fwStatus').textContent = 'reading firmware…';
  await readVersion();
  const current = $('version').textContent;
  $('fwStatus').className = 'status';
  $('fwStatus').textContent =
    `current firmware ${current === '—' ? 'unknown' : current}. ` +
    'QCY publishes updates only through its mobile app: the OTA API requires an account token and blocks browser access.';
}

async function readNoise() {
  await sendCommand(0xfe, [0x07]);
  log('sys', 'requested noise level (cmd 0x07)');
}

async function readSnapshot() {
  const uuid = state.family === 'jl' ? JL_CHAR.notify : CHAR.notify;
  const c = state.chars.get(uuid);
  if (!c || !c.properties.read) {
    log('err', `${uuid.slice(0, 8)} is not readable on this device`);
    return;
  }
  const v = await c.readValue();
  handleNotify(uuid, new Uint8Array(v.buffer));
}

function handleNotify(uuid, bytes) {
  log('rx', `${uuid.slice(0, 8)}  ${formatHex(bytes)}`);
  const prev = rxPending.get(uuid);
  let data = bytes;
  if (prev && prev.length) {
    data = new Uint8Array(prev.length + bytes.length);
    data.set(prev);
    data.set(bytes, prev.length);
  }

  let rest = new Uint8Array(0);

  if (state.family === 'qcy') {
    if (uuid === CHAR.battery) return showBattery(parseBattery(bytes));
    if (uuid === CHAR.eq) return handleEq(bytes);
    if (uuid !== CHAR.notify) return;
    const parsed = parseFramesStream(data);
    rest = parsed.rest;
    for (const b of parsed.frames) handleCommand(b.cmd, b.payload);
  } else {
    const parsed = parseRcspStream(data);
    rest = parsed.rest;
    for (const f of parsed.frames) {
      if (f.status !== undefined && f.status !== 0) {
        log('err', `rcsp op 0x${f.opcode.toString(16)} status ${f.status}`);
        continue;
      }
      if (f.opcode === 0xff) {
        const blocks = parseQcyBlocks(f.payload);
        if (blocks.length) {
          for (const b of blocks) {
            if (b.cmd === 34) handleEqParams(b.payload);
            else handleCommand(b.cmd, b.payload);
          }
        } else if (pendingAnc && !pendingAnc.acked) {
          // Status-only ack: the device accepted the write but does not echo the
          // new state, so ask for it explicitly.
          pendingAnc.acked = true;
          setAncStatus('accepted, reading state…', 'busy');
          setTimeout(() => {
            if (pendingAnc && !pendingAnc.readSent) {
              pendingAnc.readSent = true;
              sendCommand(0xfe, [0x17]).catch(() => {});
            }
          }, 200);
        }
      } else if (f.opcode === 7) {
        const { attrs } = parseSysInfo(f.payload);
        const battery = attrs.find((a) => a.type === 0);
        if (battery) {
          const value = battery.data[0] ?? 0;
          $('battery').textContent = `device ${value & 0x7f}%${value & 0x80 ? ' ⚡' : ''}`;
        }
        const eq = attrs.find((a) => a.type === 4);
        if (eq) handleEq(Uint8Array.from(eq.data));
      } else if (f.opcode === 8 && f.status === 0) {
        setEqStatus('accepted, reading equalizer…', 'busy');
        setTimeout(() => readEq(), 250);
      }
    }
  }

  if (rest.length) rxPending.set(uuid, rest);
  else rxPending.delete(uuid);
}

function handleCommand(cmd, payload) {
  if (cmd === 0x07) $('noiseLevel').textContent = payload[0] ?? '—';
  if (cmd === 0x0c) {
    const mode = payload[0];
    const name = Object.keys(NOISE_MODE).find((k) => NOISE_MODE[k] === mode);
    $('noiseMode').textContent = `mode ${mode} (${name ?? 'raw'})`;
  }
  if (cmd === 0x17) {
    const [mode, scene, level] = payload;
    state.anc = { mode, scene, level };
    updateCycle();
    $('noiseMode').textContent = `${presetName(mode, scene)} (${mode}/${scene}/${level})`;
    markPreset(mode, scene, level);
    if (ancTimer) clearTimeout(ancTimer);
    ancTimer = null;
    pendingAnc = null;
    setAncStatus(`applied: ${presetName(mode, scene)} · ${mode}/${scene}/${level}`, 'ok');
  }
  if (cmd === 0x2f && payload.length >= 3) showBattery(parseBattery(Uint8Array.from(payload)));
  if (cmd === 0x30 && payload.length >= 3) {
    showVersion({ left: payload.slice(0, 3).join('.'), right: null });
  }
}

function showBattery({ left, right, case: box }) {
  const fmt = (b) => (b ? `${b.level}%${b.charging ? ' ⚡' : ''}` : '—');
  $('battery').textContent = `L ${fmt(left)}  R ${fmt(right)}  case ${fmt(box)}`;
}

function showVersion({ left, right }) {
  $('version').textContent = `${left ?? '—'}${right ? ` / ${right}` : ''}`;
}

function markPreset(mode, scene, level) {
  for (const b of document.querySelectorAll('[data-preset]')) {
    const [m, s] = b.dataset.preset.split(',').map(Number);
    b.classList.toggle('active', m === mode && s === scene);
  }
  const preset = ANC_PRESETS.find((p) => p.bytes[0] === mode && p.bytes[1] === scene);
  if (preset && preset.levels) {
    $('ancLevel').hidden = false;
    $('ancLevel').value = String(Math.min(level, preset.levels - 1));
  } else {
    $('ancLevel').hidden = true;
  }
}

async function sendRaw() {
  try {
    const input = parseHex($('raw').value);
    if (!input.length) return;
    if (state.family === 'jl') {
      const body = input[0] === 0xff ? input.slice(1) : input;
      await writeRaw(JL_CHAR.write, encodeRcsp(255, [...body], state.sn++ & 0xff));
      return;
    }
    const frame = input[0] === 0xff ? input : encodeFrames([{ cmd: input[0], payload: input.slice(1) }]);
    await writeRaw(CHAR.write, frame);
  } catch (e) {
    log('err', `raw: ${e.message}`);
  }
}

async function sendPreset(button) {
  const [mode, scene] = button.dataset.preset.split(',').map(Number);
  await applyPreset(mode, scene);
}

async function applyPreset(mode, scene, levelOverride) {
  const preset = ANC_PRESETS.find((p) => p.bytes[0] === mode && p.bytes[1] === scene);
  const level =
    levelOverride !== undefined
      ? levelOverride
      : preset && preset.levels
        ? Number($('ancLevel').value) || 0
        : preset
          ? preset.bytes[2]
          : 0;
  setAncStatus(`sending ${presetName(mode, scene)}…`, 'busy');
  if (ancTimer) clearTimeout(ancTimer);
  pendingAnc = { acked: false, readSent: false };
  ancTimer = setTimeout(() => {
    ancTimer = null;
    const lost = pendingAnc;
    pendingAnc = null;
    setAncStatus(
      lost && lost.acked
        ? 'device accepted the command but reported no state'
        : 'no confirmation from the device',
      'err',
    );
  }, 4000);
  try {
    await sendCommand(0x17, [mode, scene, level]);
    // Ask for the current state shortly after the write; some devices only
    // acknowledge the write and never push the new state.
    setTimeout(() => readBackAnc(), 400);
    setTimeout(() => readBackAnc(true), 1600);
  } catch (e) {
    if (ancTimer) clearTimeout(ancTimer);
    ancTimer = null;
    setAncStatus(`send failed: ${e.message}`, 'err');
  }
}

async function readBackAnc(force = false) {
  if (!pendingAnc) return;
  if (pendingAnc.readSent && !force) return;
  pendingAnc.readSent = true;
  try {
    await sendCommand(0xfe, [0x17]);
  } catch {}
}

$('connect').addEventListener('click', connect);
$('pickLe').addEventListener('click', pickLe);
$('reconnect').addEventListener('click', () => reconnectSaved());
$('disconnect').addEventListener('click', () => state.device?.gatt?.disconnect());
$('readBattery').addEventListener('click', readBattery);
$('readVersion').addEventListener('click', readVersion);
$('cycleAnc').addEventListener('click', () => {
  const list = cycleList();
  if (!list.length) return;
  cycleCursor = (cycleCursor + 1) % list.length;
  const preset = presetByKey(list[cycleCursor]);
  applyPreset(preset.bytes[0], preset.bytes[1], 0);
});
$('checkFw').addEventListener('click', checkFirmware);
$('readAnc').addEventListener('click', readAnc);
$('readNoise').addEventListener('click', readNoise);
$('readSnapshot').addEventListener('click', readSnapshot);
$('sendRaw').addEventListener('click', sendRaw);
$('sendAnc').addEventListener('click', async () => {
  const payload = [
    Number($('ancMode').value),
    Number($('ancScene').value),
    Number($('ancLevelCustom').value),
  ];
  setAncStatus(`sending custom ${payload.join('/')}…`, 'busy');
  try {
    await sendCommand(0x17, payload);
  } catch (e) {
    setAncStatus(`send failed: ${e.message}`, 'err');
  }
});
for (const b of document.querySelectorAll('[data-eq]')) {
  b.addEventListener('click', () => applyEq(Number(b.dataset.eq)));
}
for (const b of document.querySelectorAll('[data-preset]')) {
  b.addEventListener('click', () => sendPreset(b));
}
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => sendCommand(0x0c, [Number(b.dataset.mode)]));
}
$('ancLevel').addEventListener('change', () => {
  const active = document.querySelector('[data-preset].active');
  if (active) sendPreset(active);
});

loadCycle();
setControls();
if (!navigator.bluetooth) {
  $('noBt').hidden = false;
} else if (typeof navigator.bluetooth.getDevices === 'function') {
  navigator.bluetooth
    .getDevices()
    .then((devices) => {
      if (devices.length) {
        $('reconnect').hidden = false;
        $('reconnect').textContent = `Reconnect ${devices[0].name || 'saved device'}`;
        reconnectSaved({ auto: true });
      }
    })
    .catch(() => {});
}
