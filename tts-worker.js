// VoicePress AI voice worker: Piper text-to-speech (open-source, MIT) running on this computer.
/* global ort */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.wasm.min.js', 'lame.min.js');
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
ort.env.wasm.numThreads = 1;

const HF = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const PHONEMIZE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const GLUE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';
const CACHE = 'voicepress-voices';

let glue = null;
const voices = {}; // voiceId -> { session, config }

function pathOf(id) {
  // e.g. vi_VN-vais1000-medium -> vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
  const m = id.match(/^(([a-z]{2})_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
  if (!m) throw new Error('Unknown voice ' + id);
  return `${m[2]}/${m[1]}/${m[3]}/${m[4]}/${id}.onnx`;
}

async function fetchCached(url, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const total = +(res.headers.get('Content-Length') || 0);
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const blob = new Blob(parts);
  try { await cache.put(url, new Response(blob)); } catch (_) {}
  return blob.arrayBuffer();
}

async function loadVoice(id, report) {
  if (voices[id]) return voices[id];
  const p = pathOf(id);
  const config = JSON.parse(new TextDecoder().decode(await fetchCached(`${HF}/${p}.json`)));
  const model = await fetchCached(`${HF}/${p}`, (l, t) => report && report(l, t));
  const session = await ort.InferenceSession.create(model);
  voices[id] = { session, config };
  return voices[id];
}

async function phonemize(text, espeakVoice) {
  if (!glue) glue = await import(GLUE);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Phonemizer timed out')), 20000);
    glue.createPiperPhonemize({
      print: (line) => { clearTimeout(timer); try { resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); } },
      printErr: () => {},
      locateFile: (f) => (f.endsWith('.wasm') ? `${PHONEMIZE}.wasm` : f.endsWith('.data') ? `${PHONEMIZE}.data` : f),
    }).then((mod) => mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']))
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function speak(id, text, speed) {
  const v = await loadVoice(id, (l, t) => self.postMessage({ type: 'progress', loaded: l, total: t }));
  const cfg = v.config;
  const ids = await phonemize(text, cfg.espeak.voice);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? 0.8]), [3]),
  };
  if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await v.session.run(feeds);
  const data = Float32Array.from(out.output.data);
  return { data, sampleRate: cfg.audio.sample_rate };
}

// ---- MP3 (lamejs, LGPL) ----
function toMp3(pcm, rate, kbps) {
  const enc = new lamejs.Mp3Encoder(1, rate, kbps || 48);
  const out = [];
  const step = 1152 * 8;
  for (let i = 0; i < pcm.length; i += step) { const b = enc.encodeBuffer(pcm.subarray(i, i + step)); if (b.length) out.push(new Uint8Array(b)); }
  const f = enc.flush(); if (f.length) out.push(new Uint8Array(f));
  const n = out.reduce((s, b) => s + b.length, 0), mp3 = new Uint8Array(n);
  let o = 0; for (const b of out) { mp3.set(b, o); o += b.length; }
  return mp3;
}
// exact playing time of an MP3 stream: count its frames
function mp3Seconds(u) {
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let i = 0, samples = 0, rate = 0;
  while (i + 4 <= u.length) {
    if (u[i] !== 0xff || (u[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (u[i + 1] >> 3) & 3, br = (u[i + 2] >> 4) & 15, sri = (u[i + 2] >> 2) & 3, pad = (u[i + 2] >> 1) & 1;
    if (ver === 1 || br === 0 || br === 15 || sri === 3) { i++; continue; }
    rate = SR[ver][sri];
    const kb = (ver === 3 ? BR1 : BR2)[br], spf = ver === 3 ? 1152 : 576;
    const len = Math.floor((spf / 8) * kb * 1000 / rate) + pad;
    samples += spf; i += len;
  }
  return rate ? samples / rate : 0;
}
function silence(sec, rate) { return new Float32Array(Math.max(0, Math.round(sec * rate))); }
// say one piece of text and return it as MP3, with quiet time before and after
async function make(m) {
  const r = await speak(m.voice, m.text, m.speed);
  const rate = r.sampleRate, a = silence(m.before || 0, rate), b = silence(m.after || 0, rate);
  let peak = 0; for (let i = 0; i < r.data.length; i++) { const v = Math.abs(r.data[i]); if (v > peak) peak = v; }
  const gain = peak > 0 ? Math.min(3, 0.89 / peak) : 1; // even loudness from sentence to sentence
  const pcm = new Int16Array(a.length + r.data.length + b.length);
  for (let i = 0; i < r.data.length; i++) pcm[a.length + i] = Math.max(-32767, Math.min(32767, Math.round(r.data[i] * gain * 32767)));
  const mp3 = toMp3(pcm, rate, m.kbps);
  return { mp3, dur: mp3Seconds(mp3), rate };
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'speak') {
      const r = await speak(m.voice, m.text, m.speed);
      self.postMessage({ type: 'audio', id: m.id, data: r.data, sampleRate: r.sampleRate }, [r.data.buffer]);
    } else if (m.type === 'make') {
      const r = await make(m);
      self.postMessage({ type: 'mp3', id: m.id, mp3: r.mp3, dur: r.dur, rate: r.rate }, [r.mp3.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
