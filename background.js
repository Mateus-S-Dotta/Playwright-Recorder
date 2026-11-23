// Service worker: controla o ciclo da gravação.
//   1º clique no ícone (▶) → começa a gravar a aba atual (ícone vira ● vermelho)
//   2º clique (●)          → finaliza, baixa o .spec.ts e o vídeo da aba
// Os passos ficam em chrome.storage.session no formato JSON do DevTools Recorder,
// para sobreviver ao service worker ser desligado pelo Chrome no meio da gravação.
import { recordingToPlaywright } from './converter.js';

const KEY = 'gravacao';
const SCRIPT_ID = 'gravador';
const RECORDABLE = /^(https?|file):/;
// o gerador de seletores do Playwright precisa carregar antes do gravador
const RECORDER_FILES = ['vendor/playwright-injected.js', 'recorder.js'];
// tempo máximo entre uma ação e a navegação que ela causou
const NAV_WINDOW_MS = 10_000;

// ---------- estado (serializado numa fila para não perder passos) ----------

let queue = Promise.resolve();

function run(fn) {
  const result = queue.then(fn);
  queue = result.catch((e) => console.error('[gravador]', e));
  return result;
}

async function getState() {
  return (await chrome.storage.session.get(KEY))[KEY] || null;
}

function setState(state) {
  return state ? chrome.storage.session.set({ [KEY]: state }) : chrome.storage.session.remove(KEY);
}

/** Altera o estado atual (se estiver gravando) dentro da fila. */
function mutate(fn) {
  return run(async () => {
    const state = await getState();
    if (!state) return;
    fn(state);
    await setState(state);
  });
}

// ---------- ícone ----------

function drawIcon(recording, size) {
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r - 0.5, 0, Math.PI * 2);
  g.fillStyle = recording ? '#57606a' : '#1a7f37';
  g.fill();
  g.fillStyle = recording ? '#ff5a5f' : '#ffffff';
  g.beginPath();
  if (recording) {
    // ● REC: gravando, clique para finalizar
    g.arc(r, r, r * 0.42, 0, Math.PI * 2);
  } else {
    // ▶ play: parado, clique para gravar
    g.moveTo(size * 0.38, size * 0.27);
    g.lineTo(size * 0.38, size * 0.73);
    g.lineTo(size * 0.76, size * 0.5);
    g.closePath();
  }
  g.fill();
  return g.getImageData(0, 0, size, size);
}

async function updateIcon(recording) {
  await chrome.action.setIcon({ imageData: { 16: drawIcon(recording, 16), 32: drawIcon(recording, 32) } });
  await chrome.action.setTitle({
    title: recording ? 'Gravando… clique para finalizar e baixar o teste' : 'Clique para começar a gravar esta aba',
  });
  await chrome.action.setBadgeText({ text: '' });
}

async function flashError(tabId, message) {
  await chrome.action.setBadgeBackgroundColor({ color: '#cf222e', tabId });
  await chrome.action.setBadgeText({ text: '!', tabId });
  await chrome.action.setTitle({ title: message, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: '', tabId }).catch(() => {});
  }, 4000);
}

// ---------- iniciar / finalizar ----------

async function start(tab) {
  if (!RECORDABLE.test(tab.url || '')) {
    await flashError(tab.id, 'Abra um site (http/https) antes de gravar.');
    return;
  }

  // precisa ser o primeiro await: a permissão de capturar a aba vem do clique no ícone
  const video = await startVideo(tab.id);

  let viewport = { width: tab.width, height: tab.height };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ width: innerWidth, height: innerHeight }),
    });
    viewport = result;
  } catch (e) {
    if (video) await discardVideo();
    await flashError(tab.id, `Não foi possível gravar esta página: ${e.message}`);
    return;
  }

  await setState({
    tabId: tab.id,
    title: pageTitle(tab) || new URL(tab.url).hostname,
    startedAt: Date.now(),
    lastActionAt: 0,
    video,
    steps: [
      { type: 'setViewport', width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { type: 'navigate', url: tab.url, assertedEvents: [{ type: 'navigation', url: tab.url, title: pageTitle(tab) }] },
    ],
  });

  // páginas novas (navegação, iframes) recebem o gravador automaticamente…
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    js: RECORDER_FILES,
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: false,
  }]);
  // …e a página que já está aberta recebe agora
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: RECORDER_FILES }).catch(() => {});

  await updateIcon(true);
}

/** Finaliza a gravação, baixa o .spec.ts e devolve o código gerado. */
async function stop() {
  const state = await run(async () => {
    const s = await getState();
    await setState(null);
    return s;
  });
  if (!state) return null;

  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  chrome.tabs.sendMessage(state.tabId, { type: 'rec:stop' }).catch(() => {});
  await updateIcon(false);

  const code = recordingToPlaywright({ title: state.title, steps: state.steps });
  const base = fileName(state.title, state.startedAt);
  // octet-stream: com text/plain o Chrome no Windows troca ".ts" (que lá é vídeo MPEG-TS) por ".txt"
  await download('data:application/octet-stream;base64,' + base64(code), `${base}.spec.ts`);
  if (state.video) await saveVideo(base);
  return code;
}

// ---------- vídeo (chrome.tabCapture + documento offscreen) ----------

const OFFSCREEN = 'offscreen.html';

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

function toOffscreen(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra });
}

/** Começa a gravar o vídeo da aba. Se não der, a gravação dos passos segue sem vídeo. */
async function startVideo(tabId) {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await closeOffscreen();
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ['USER_MEDIA'],
      justification: 'Gravar o vídeo da aba durante a gravação do teste',
    });
    const res = await toOffscreen('video:start', { streamId });
    if (res?.error) throw new Error(res.error);
    return true;
  } catch (e) {
    console.warn('[gravador] vídeo indisponível:', e.message);
    await closeOffscreen();
    return false;
  }
}

async function discardVideo() {
  await toOffscreen('video:stop').catch(() => {});
  await closeOffscreen();
}

/** Para o vídeo e baixa o arquivo com o mesmo nome do teste. */
async function saveVideo(base) {
  try {
    if (!(await hasOffscreen())) return;
    const res = await toOffscreen('video:stop').catch(() => null);
    if (!res?.url) return;
    const id = await download(res.url, `${base}.${res.ext}`);
    await downloadFinished(id); // a URL blob: deixa de existir quando o documento offscreen fecha
  } catch (e) {
    console.warn('[gravador] falha ao salvar o vídeo:', e.message);
  } finally {
    await closeOffscreen();
  }
}

// ---------- downloads ----------

const ourDownloads = new Map(); // url → nome do arquivo (o evento abaixo pode vir antes do id)

async function download(url, filename) {
  ourDownloads.set(url, filename);
  setTimeout(() => ourDownloads.delete(url), 60_000);
  return chrome.downloads.download({ url, filename, saveAs: false });
}

// garante o nome/extensão escolhidos, mesmo se o Chrome quiser "corrigir" pela MIME
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = item.byExtensionId === chrome.runtime.id && ourDownloads.get(item.url);
  if (filename) suggest({ filename, conflictAction: 'uniquify' });
  else suggest();
});

function downloadFinished(id) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve();
    };
    const onChanged = (delta) => {
      if (delta.id === id && ['complete', 'interrupted'].includes(delta.state?.current)) done();
    };
    const timer = setTimeout(done, 120_000);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== 'in_progress') done();
    });
  });
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Título real da aba (sem <title>, o Chrome mostra a URL no lugar). */
function pageTitle(tab) {
  const t = tab.title || '';
  return !t || tab.url?.includes(t) ? '' : t;
}

function fileName(title, time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `gravacao-${slug || 'teste'}-${stamp}`;
}

async function toggle(tab) {
  if (await getState()) return stop();
  await start(tab);
  return null;
}

// usado pelo teste automatizado (extension/test/e2e.js)
globalThis.__gravador = { toggle, getState };

// ---------- eventos ----------

chrome.action.onClicked.addListener((tab) => { toggle(tab); });

chrome.runtime.onInstalled.addListener(() => updateIcon(false));
chrome.runtime.onStartup.addListener(() => updateIcon(false));
getState().then((s) => updateIcon(!!s));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'rec:hello') {
    getState().then((s) => sendResponse({ active: !!s && sender.tab?.id === s.tabId }));
    return true; // resposta assíncrona
  }
  if (msg.type === 'rec:steps') {
    mutate((s) => {
      if (sender.tab?.id !== s.tabId) return;
      for (const step of msg.steps) addStep(s, step);
      s.lastActionAt = Date.now();
    });
  }
  return false;
});

function addStep(state, step) {
  if (step.type === 'doubleClick') {
    // o navegador dispara click, click, dblclick: troca os dois cliques pelo duplo clique
    const same = elementKey(step);
    for (let i = 0; i < 2; i++) {
      const last = state.steps[state.steps.length - 1];
      if (last?.type === 'click' && elementKey(last) === same) state.steps.pop();
    }
  }
  state.steps.push(step);
}

function elementKey(step) {
  return step.selector ?? JSON.stringify(step.selectors);
}

const TYPED = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page', 'reload']);

function onNavigation(details) {
  if (details.frameId !== 0) return;
  mutate((s) => {
    if (details.tabId !== s.tabId) return;
    const q = details.transitionQualifiers || [];
    const last = s.steps[s.steps.length - 1];
    const lastNav = last?.assertedEvents?.find((e) => e.type === 'navigation');

    // redirecionamento feito por JS logo após uma navegação: espera a URL final
    if (q.includes('client_redirect')) {
      if (lastNav) lastNav.url = details.url;
      return;
    }
    // URL digitada, favorito, voltar/avançar, recarregar → page.goto
    if (TYPED.has(details.transitionType) || q.includes('from_address_bar') || q.includes('forward_back')) {
      s.steps.push({ type: 'navigate', url: details.url, assertedEvents: [{ type: 'navigation', url: details.url, title: '' }] });
      return;
    }
    // navegação causada pela última ação (clique em link, Enter num formulário…) → waitForURL
    if (last && last.type !== 'navigate' && last.type !== 'setViewport' && details.timeStamp - s.lastActionAt < NAV_WINDOW_MS) {
      last.assertedEvents = [{ type: 'navigation', url: details.url, title: '' }];
    }
  });
}

chrome.webNavigation.onCommitted.addListener(onNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onNavigation);

// título da página para o toHaveTitle dos passos "navigate"
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId).then((tab) => mutate((s) => {
    if (details.tabId !== s.tabId) return;
    const step = [...s.steps].reverse().find((st) => st.type === 'navigate' && st.url === details.url);
    const nav = step?.assertedEvents?.[0];
    if (nav && !nav.title) nav.title = pageTitle(tab);
  })).catch(() => {});
});

// fechou a aba que estava gravando: finaliza e baixa o que já foi gravado
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s && s.tabId === tabId) stop();
});
