// Testa o webm-fix.js com vídeos de verdade: grava ~6 s com o MediaRecorder do Chromium
// (mesmas opções do offscreen.js) e confere que, depois da correção:
//   - o player do Chromium vê a duração e consegue pular para o meio do vídeo;
//   - a estrutura do arquivo está certa (conferida por um leitor independente, abaixo):
//     Duration, SeekHead e Cues apontando para os lugares certos, tamanhos batendo.
// Rodar: ./npm.sh run test:extension:video
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const FIX = fileURLToPath(new URL('../webm-fix.js', import.meta.url));
const SECONDS = 6;
// opaco = como a captura de aba (SimpleBlock); transparente = BlockGroup
const CASES = [
  { codec: 'vp8', alpha: false },
  { codec: 'vp8', alpha: true },
  { codec: 'vp9', alpha: false },
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  for (const { codec, alpha } of CASES) {
    console.log(`--- ${codec}, ${alpha ? 'com' : 'sem'} transparência`);
    await page.setContent('<canvas width="320" height="240"></canvas>');
    await page.addScriptTag({ path: FIX });
    const result = await page.evaluate(recordAndFix, { seconds: SECONDS, alpha, codec });

    assert.equal(result.before.duration, Infinity, 'o WebM original deveria vir sem duração (senão o teste não prova nada)');
    assert.ok(Math.abs(result.after.duration - SECONDS) < 1, `duração corrigida: ${result.after.duration}`);
    assert.ok(result.after.seeked, 'deveria conseguir pular no tempo');
    assert.ok(Math.abs(result.after.currentTime - SECONDS / 2) < 0.5, `foi para ${result.after.currentTime}s`);
    assert.ok(result.after.seekable >= SECONDS - 1, `faixa navegável até ${result.after.seekable}s`);

    const s = checkStructure(Buffer.from(result.fixed, 'base64'));
    assert.ok(s.cues >= SECONDS / 2 - 1, `poucos pontos de navegação: ${s.cues}`);
    console.log(`✔ duração ${result.after.duration.toFixed(2)}s, pulou para ${result.after.currentTime}s, ` +
      `${s.cues} pontos de navegação em ${s.clusters} clusters, +${result.fixed.length * 3 / 4 - result.originalSize | 0} bytes`);
  }
} finally {
  await browser.close();
}

// ---------- roda no navegador ----------

async function recordAndFix({ seconds, alpha, codec }) {
  // vídeo: canvas animado; áudio: um tom
  const canvas = document.querySelector('canvas');
  const g = canvas.getContext('2d', { alpha });
  let frame = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(frame += 7) % 360} 80% 50%)`;
    g.fillRect(0, 0, 320, 240);
    g.fillStyle = '#000';
    g.fillText(String(frame), 10, 20);
  }, 33);
  const audio = new AudioContext();
  const osc = audio.createOscillator();
  const dest = audio.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);

  const rec = new MediaRecorder(stream, { mimeType: `video/webm;codecs=${codec},opus`, videoKeyFrameIntervalDuration: 2000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());

  const original = new Blob(chunks, { type: 'video/webm' });
  const fixed = await fixWebm(original);

  async function probe(blob) {
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    await new Promise((ok, fail) => { v.onloadedmetadata = ok; v.onerror = () => fail(new Error('não abriu')); });
    const duration = v.duration;
    v.currentTime = seconds / 2;
    const seeked = await Promise.race([
      new Promise((r) => { v.onseeked = () => r(true); }),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    const seekable = v.seekable.length ? v.seekable.end(0) : 0;
    return { duration, seeked, currentTime: v.currentTime, seekable };
  }

  const bytes = new Uint8Array(await fixed.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    originalSize: original.size,
    before: await probe(original),
    after: await probe(fixed),
    fixed: btoa(bin),
  };
}

// ---------- leitor EBML independente (não reaproveita o código do webm-fix.js) ----------

function checkStructure(buf) {
  const vint = (pos, keepMarker) => {
    let len = 1;
    while (len <= 8 && !(buf[pos] & (0x80 >> (len - 1)))) len++;
    assert.ok(len <= 8, `número EBML inválido na posição ${pos}`);
    let value = keepMarker ? buf[pos] : buf[pos] & (0xFF >> len);
    for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
    return { value, len };
  };
  const el = (pos) => {
    const id = vint(pos, true);
    const size = vint(pos + id.len, false);
    const data = pos + id.len + size.len;
    return { id: id.value, data, end: data + size.value };
  };
  const kids = (from, to) => {
    const out = [];
    for (let p = from; p < to;) { const e = el(p); out.push(e); p = e.end; }
    assert.equal(out.at(-1)?.end ?? to, to, 'filhos não fecham com o tamanho do pai');
    return out;
  };
  const uint = (e) => { let n = 0; for (let i = e.data; i < e.end; i++) n = n * 256 + buf[i]; return n; };

  const ebml = el(0);
  assert.equal(ebml.id, 0x1A45DFA3);
  const seg = el(ebml.end);
  assert.equal(seg.id, 0x18538067);
  assert.equal(seg.end, buf.length, 'tamanho do Segment não bate com o arquivo');
  const top = kids(seg.data, seg.end);
  const at = (rel) => el(seg.data + rel);

  // SeekHead → Info, Tracks e Cues
  const seekHead = top.find((e) => e.id === 0x114D9B74);
  assert.ok(seekHead, 'sem SeekHead');
  for (const seek of kids(seekHead.data, seekHead.end)) {
    const [id, pos] = kids(seek.data, seek.end);
    const target = buf.readUIntBE(id.data, id.end - id.data);
    assert.equal(at(uint(pos)).id, target, `SeekHead aponta para o lugar errado (0x${target.toString(16)})`);
  }

  // Duration dentro de Info
  const info = top.find((e) => e.id === 0x1549A966);
  const duration = kids(info.data, info.end).find((e) => e.id === 0x4489);
  assert.ok(duration && buf.readDoubleBE(duration.data) > 0, 'sem Duration');

  // cada Cluster com tamanho conhecido; cada CuePoint aponta para um Cluster que começa antes do CueTime
  const clusters = top.filter((e) => e.id === 0x1F43B675);
  const clusterTime = (c) => uint(kids(c.data, c.end).find((e) => e.id === 0xE7));
  const cues = top.find((e) => e.id === 0x1C53BB6B);
  assert.ok(cues, 'sem Cues');
  const points = kids(cues.data, cues.end);
  let lastTime = -1;
  for (const cp of points) {
    const [time, positions] = kids(cp.data, cp.end);
    const clusterPos = kids(positions.data, positions.end).find((e) => e.id === 0xF1);
    const cluster = at(uint(clusterPos));
    assert.equal(cluster.id, 0x1F43B675, 'CuePoint não aponta para um Cluster');
    assert.ok(clusterTime(cluster) <= uint(time), 'CueTime antes do início do Cluster');
    assert.ok(uint(time) > lastTime, 'CueTimes fora de ordem');
    lastTime = uint(time);
  }
  return { cues: points.length, clusters: clusters.length };
}
