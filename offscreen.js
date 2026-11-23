// Documento offscreen: grava o vídeo da aba com MediaRecorder.
// O service worker não tem acesso a getUserMedia/MediaRecorder, então ele pede
// o streamId da aba (chrome.tabCapture) e manda para cá.
//   video:start { streamId } → começa a gravar
//   video:stop               → finaliza e responde { url, ext } (blob: URL que o SW baixa)

let recorder = null;
let finished = null; // Promise<{ url, ext }> resolvida quando o recorder para
let stream = null;
let audioCtx = null;

// WebM porque dá para corrigir no fim (webm-fix.js) e deixar o vídeo navegável.
// VP8 gasta menos CPU que VP9 em gravações longas.
const FORMATS = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

async function start(streamId) {
  const tab = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  stream = await navigator.mediaDevices.getUserMedia({ audio: tab, video: tab });

  // capturar o áudio da aba deixa ela muda para o usuário: devolve o som para os alto-falantes
  if (stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  }

  const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
  recorder = new MediaRecorder(stream, {
    ...(mimeType && { mimeType }),
    // um quadro-chave a cada 2 s: é onde o player consegue pular no tempo (Chrome 124+; antes é ignorado)
    videoKeyFrameIntervalDuration: 2000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  finished = new Promise((resolve) => {
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
      let blob = new Blob(chunks, { type: 'video/webm' });
      try {
        blob = await fixWebm(blob); // duração + índice, para poder pular no tempo
      } catch (e) {
        console.warn('[gravador] vídeo salvo sem índice de navegação:', e.message);
      }
      resolve({ url: URL.createObjectURL(blob), ext: 'webm' });
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
