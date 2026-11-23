// Documento offscreen: grava o vídeo da aba com MediaRecorder.
// O service worker não tem acesso a getUserMedia/MediaRecorder, então ele pede
// o streamId da aba (chrome.tabCapture) e manda para cá.
//   video:start { streamId } → começa a gravar
//   video:stop               → finaliza e responde { url, ext } (blob: URL que o SW baixa)

let recorder = null;
let finished = null; // Promise<{ url, ext }> resolvida quando o recorder para
let stream = null;
let audioCtx = null;

// MP4 abre em qualquer player do Windows/Mac; WebM é o fallback de Chromes antigos (< 126)
const FORMATS = [
  { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

async function start(streamId) {
  const tab = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  stream = await navigator.mediaDevices.getUserMedia({ audio: tab, video: tab });

  // capturar o áudio da aba deixa ela muda para o usuário: devolve o som para os alto-falantes
  if (stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  }

  const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) || { mime: '', ext: 'webm' };
  recorder = new MediaRecorder(stream, format.mime ? { mimeType: format.mime } : {});
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  finished = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
      const blob = new Blob(chunks, { type: recorder.mimeType || format.mime || 'video/webm' });
      resolve({ url: URL.createObjectURL(blob), ext: format.ext });
    };
  });
  recorder.start(1000); // um pedaço por segundo: não perde tudo se algo der errado no fim
}

async function stop() {
  if (!recorder) return null;
  // a aba pode ter sido fechada: aí o stream já acabou e o recorder parou sozinho
  if (recorder.state !== 'inactive') recorder.stop();
  return finished;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  const job = msg.type === 'video:start' ? start(msg.streamId).then(() => ({ ok: true }))
    : msg.type === 'video:stop' ? stop()
    : null;
  if (!job) return false;
  job.then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true; // resposta assíncrona
});
