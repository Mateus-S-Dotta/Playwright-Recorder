// Content script: captura as ações do usuário na página e envia ao service worker
// no formato de "steps" do Chrome DevTools Recorder (click, change, keyDown/keyUp...).
// Roda em todas as páginas/iframes enquanto a gravação está ligada, mas só grava
// na aba que o service worker confirmar (mensagem "rec:hello").
(() => {
  // já injetado antes (nova gravação na mesma página): só pergunta de novo se deve gravar
  if (window.__gravadorPlaywright) {
    window.__gravadorPlaywright();
    return;
  }

  let active = false;

  // ---------- seletores: o mesmo gerador do codegen do Playwright ----------
  // vendor/playwright-injected.js (carregado antes deste arquivo) expõe o InjectedScript
  // do Playwright. generateSelector() escolhe o seletor exatamente como o codegen
  // (getByTestId > getByRole > getByLabel/Placeholder/Text > CSS...) e asLocator()
  // transforma em código: internal:role=button[name="Salvar"i] → getByRole('button', { name: 'Salvar' }).

  const TEST_ID_ATTRIBUTE = 'data-testid'; // o mesmo padrão do Playwright (testIdAttribute)
  let injected = null;

  /** { selector, locator } do elemento, ou um CSS posicional se o gerador do Playwright falhar. */
  function locatorFor(el) {
    try {
      injected ||= globalThis.__pwGravador.create(TEST_ID_ATTRIBUTE);
      const { selector } = injected.generateSelector(el, { testIdAttributeName: TEST_ID_ATTRIBUTE });
      return { selector, locator: injected.utils.asLocator('javascript', selector) };
    } catch (e) {
      console.warn('[gravador] gerador do Playwright falhou, usando CSS posicional:', e);
      const css = cssPath(el);
      return { selector: css, locator: `locator(${JSON.stringify(css)})`, fragile: true };
    }
  }

  function cssPath(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      let part = cur.localName;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === cur.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  /** Dados do elemento que vão no step: { selector, locator, tag, fragile? }. */
  function describe(el) {
    return { ...locatorFor(el), tag: el.localName };
  }

  /** Índices dos iframes até este documento (step.frame do Recorder). */
  function framePath() {
    const path = [];
    try {
      let w = window;
      while (w !== w.top) {
        const parent = w.parent;
        let index = -1;
        for (let i = 0; i < parent.frames.length; i++) {
          if (parent.frames[i] === w) { index = i; break; }
        }
        path.unshift(index);
        w = parent;
      }
    } catch { /* acesso negado: fica o que deu */ }
    return path;
  }

  // ---------- envio ----------

  function send(...steps) {
    if (!active) return;
    const frame = framePath();
    for (const s of steps) {
      s.target = 'main';
      if (frame.length) s.frame = frame;
    }
    chrome.runtime.sendMessage({ type: 'rec:steps', steps }).catch(() => {});
  }

  const target = (e) => (e.composedPath()[0] instanceof Element ? e.composedPath()[0] : e.target);

  const CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem]';

  function clickTarget(el) {
    // sobe até o elemento interativo (ex.: <span> dentro de <button>)
    let cur = el;
    for (let i = 0; cur && i < 5; i++) {
      if (cur.matches?.(CLICKABLE)) return cur;
      cur = cur.parentElement || cur.getRootNode().host;
    }
    return el;
  }

  // ---------- campos de texto ----------

  const TEXT_INPUT = /^(|text|email|password|search|tel|url|number|date|datetime-local|month|week|time|color)$/;
  const lastValue = new WeakMap();

  function isField(el) {
    if (el.localName === 'textarea' || el.localName === 'select') return true;
    return el.localName === 'input' && TEXT_INPUT.test((el.getAttribute('type') || '').toLowerCase());
  }

  function isPassword(el) {
    return el.localName === 'input' && el.type === 'password';
  }

  /** Grava o valor atual do campo (se mudou). Senhas nunca saem da página. */
  function flushChange(el) {
    if (!isField(el)) return;
    const value = el.value;
    if (lastValue.get(el) === value) return;
    lastValue.set(el, value);
    const step = { type: 'change', value, ...describe(el) };
    if (isPassword(el)) {
      step.value = '';
      step.sensitive = true;
    }
    send(step);
  }

  // ---------- listeners ----------

  let lastLabelClick = null;

  function onClick(e) {
    if (!e.isTrusted || e.button !== 0) return;
    // detail 0 = clique gerado por teclado (Enter/Espaço) ou repassado por <label>: a tecla já foi gravada
    if (e.detail === 0) return;
    const raw = target(e);
    const el = clickTarget(raw);
    if (el.localName === 'select' || el.localName === 'option') return; // o "change" grava a seleção
    if (el.localName === 'input' && el.type === 'file') return;
    if (lastLabelClick && lastLabelClick.control === el && e.timeStamp - lastLabelClick.time < 100) return;
    if (el.localName === 'label') lastLabelClick = { control: el.control, time: e.timeStamp };

    // o seletor sai do elemento clicado de fato: o gerador do Playwright sobe sozinho
    // até o botão/link/input mais próximo, igual ao codegen
    const rect = el.getBoundingClientRect();
    send({
      type: 'click',
      ...describe(raw),
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    });
  }

  function onDblClick(e) {
    if (!e.isTrusted) return;
    const raw = target(e);
    const rect = clickTarget(raw).getBoundingClientRect();
    send({ type: 'doubleClick', ...describe(raw), offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
  }

  function onChange(e) {
    if (!e.isTrusted) return;
    flushChange(target(e));
  }

  const SPECIAL_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'PageUp', 'PageDown', 'Home', 'End',
  ]);
  const KEYS_IN_FIELDS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);
  const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

  function onKeyDown(e) {
    if (!e.isTrusted || e.repeat || MODIFIERS.has(e.key)) return;
    const el = target(e);
    const editable = isField(el) || el.isContentEditable;
    const combo = e.ctrlKey || e.metaKey || e.altKey;

    // num <select> as setas só trocam a opção, e isso já vira um "change"
    const isSelect = el.localName === 'select';
    const record = editable
      ? (KEYS_IN_FIELDS.has(e.key) && !(isSelect && e.key.startsWith('Arrow'))) || (combo && e.key === 'Enter')
      : SPECIAL_KEYS.has(e.key) || e.key === ' ' || /^F\d{1,2}$/.test(e.key) || combo;
    if (!record) return;

    // o valor digitado vem antes da tecla (ex.: preencher e apertar Enter)
    if (editable) flushChange(el);

    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.metaKey) mods.push('Meta');
    if (e.shiftKey && (combo || e.key.length > 1)) mods.push('Shift');
    const base = e.key === ' ' ? 'Space' : e.key.length === 1 && combo ? e.key.toLowerCase() : e.key;
    const key = [...mods, base].join('+');
    send({ type: 'keyDown', key }, { type: 'keyUp', key });
  }

  function onFocusIn(e) {
    const el = target(e);
    if (isField(el) && !lastValue.has(el)) lastValue.set(el, el.value);
  }

  const listeners = [
    ['click', onClick],
    ['dblclick', onDblClick],
    ['change', onChange],
    ['keydown', onKeyDown],
    ['focusin', onFocusIn],
  ];

  function enable() {
    if (active) return;
    active = true;
    for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
    const focused = document.activeElement;
    if (focused && isField(focused)) lastValue.set(focused, focused.value);
  }

  function disable() {
    active = false;
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'rec:stop') disable();
  });

  function hello() {
    chrome.runtime.sendMessage({ type: 'rec:hello' }).then((res) => {
      if (res?.active) enable();
    }).catch(() => {});
  }

  window.__gravadorPlaywright = hello;
  hello();
})();
