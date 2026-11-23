// Converte uma gravação do Chrome DevTools Recorder (JSON) em um teste Playwright.
// Módulo ES sem dependências: roda na extensão (devtools/popup) e no Node (testes).

const INDENT = '  ';

// tag HTML -> role ARIA (para seletores "aria/Nome" que vieram sem [role=...])
const TAG_ROLE = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  li: 'listitem',
  img: 'img',
  option: 'option',
  summary: 'button',
};

const INPUT_TYPE_ROLE = {
  checkbox: 'checkbox',
  radio: 'radio',
  button: 'button',
  submit: 'button',
  reset: 'button',
  search: 'searchbox',
  range: 'slider',
  number: 'spinbutton',
};

const SENSITIVE = /password|senha|passwd|pwd/i;

/** Escapa texto para uma string JS com aspas simples. */
export function q(value) {
  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

function isPositional(css) {
  return /:nth-(of-type|child)\(|^\s*(html|body)\b/.test(css);
}

function isStableCss(css) {
  // #id, [data-testid=...], [name=...], tag#id, etc. Sem posição e sem cadeia longa.
  return !isPositional(css) && /^[a-z0-9-]*(#[\w-]+|\[(data-test(id)?|data-qa|data-cy|name|id)=["']?[^\]]+["']?\])$/i.test(css.trim());
}

/** Descobre a tag do elemento olhando o último trecho dos seletores CSS/XPath. */
function inferTag(selectors) {
  for (const chain of selectors) {
    const last = chain[chain.length - 1];
    let m;
    if (last.startsWith('xpath/')) {
      m = last.slice(6).match(/\/([a-zA-Z][\w-]*)(\[[^\]]*\])*$/);
    } else if (!/^(aria|text)\//.test(last)) {
      const css = last.replace(/^pierce\//, '').trim();
      const part = css.split(/[\s>+~]+/).pop();
      m = part.match(/^([a-zA-Z][\w-]*)/);
    }
    if (m && m[1] !== '*') return m[1].toLowerCase();
  }
  return null;
}

function inferInputType(selectors) {
  for (const chain of selectors) {
    const m = chain[chain.length - 1].match(/type=["']?(\w+)/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function inferRole(selectors) {
  const tag = inferTag(selectors);
  if (!tag) return null;
  if (tag === 'input') return INPUT_TYPE_ROLE[inferInputType(selectors)] || 'textbox';
  return TAG_ROLE[tag] || null;
}

function parseAria(raw) {
  // "Nome" | "Nome[role=\"link\"]" | "[role=\"button\"]"
  const m = raw.match(/^(.*?)(?:\[role=["']?([\w-]+)["']?\])?$/s);
  return { name: (m[1] || '').trim(), role: m[2] || null };
}

/** Converte um seletor "puppeteer" (aria/, text/, xpath/, pierce/, css) em código de locator. */
function selectorPart(sel, inferredRole) {
  if (sel.startsWith('aria/')) {
    const { name, role } = parseAria(sel.slice(5));
    const r = role || inferredRole;
    if (r) return name ? `getByRole(${q(r)}, { name: ${q(name)}, exact: true })` : `getByRole(${q(r)})`;
    return `getByLabel(${q(name)}, { exact: true })`;
  }
  if (sel.startsWith('text/')) return `getByText(${q(sel.slice(5))}, { exact: true })`;
  if (sel.startsWith('xpath/')) return `locator(${q('xpath=' + sel.slice(6))})`;
  // Playwright já atravessa shadow DOM com CSS, então pierce/ vira CSS normal
  const css = sel.replace(/^pierce\//, '');
  const testId = css.match(/^\[data-testid=["']?([^"'\]]+)["']?\]$/);
  if (testId) return `getByTestId(${q(testId[1])})`;
  return `locator(${q(css)})`;
}

function chainCode(root, chain, inferredRole) {
  return root + chain.map((s) => '.' + selectorPart(s, inferredRole)).join('');
}

/**
 * Escolhe o melhor seletor da lista do Recorder e devolve { code, fragile, raw }.
 * Prioridade: aria com role > aria + role inferido > CSS estável (#id, data-testid)
 *             > text > CSS > aria sem role (label) > xpath.
 */
export function pickLocator(selectors, root = 'page') {
  if (!selectors || !selectors.length) return null;
  const list = selectors.map((s) => (Array.isArray(s) ? s : [s]));
  const role = inferRole(list);
  const last = (c) => c[c.length - 1];
  const kind = (c) => (last(c).match(/^(aria|text|xpath|pierce)\//) || [, 'css'])[1];

  const score = (c) => {
    const s = last(c);
    switch (kind(c)) {
      case 'aria': {
        const { name, role: r } = parseAria(s.slice(5));
        if (r && name) return 100;
        if (role && name) return 90;
        return 40;
      }
      case 'text': return 60;
      case 'xpath': return /@id=/.test(s) ? 30 : 10;
      default: {
        const css = s.replace(/^pierce\//, '');
        if (isStableCss(css)) return 80;
        return isPositional(css) ? 20 : 50;
      }
    }
  };

  const best = list.map((c, i) => ({ c, s: score(c) - i * 0.01 })).sort((a, b) => b.s - a.s)[0];
  const k = kind(best.c);
  const fragile = k === 'xpath' || (k !== 'aria' && k !== 'text' && isPositional(last(best.c).replace(/^pierce\//, '')));
  return { code: chainCode(root, best.c, role), fragile, raw: list, tag: inferTag(list) };
}

// step.sensitive vem do gravador da extensão (campo type="password"); os demais casos
// são detectados pelos seletores, para JSONs exportados pelo Recorder do DevTools.
function isSensitive(step) {
  return step.sensitive === true || (step.selectors || []).flat().some((s) => SENSITIVE.test(s)) || inferInputType((step.selectors || []).map((s) => [].concat(s))) === 'password';
}

function opts(obj) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return `{ ${entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : v}`).join(', ')} }`;
}

/** Root do step: página principal ou iframe (step.frame = índices dos child frames). */
function frameRoot(step) {
  if (!step.frame || !step.frame.length) return 'page';
  return 'page.mainFrame()' + step.frame.map((i) => `.childFrames()[${i}]`).join('');
}

function navigationWaits(step) {
  const out = [];
  for (const ev of step.assertedEvents || []) {
    if (ev.type !== 'navigation') continue;
    if (ev.url) out.push(`await page.waitForURL(${q(ev.url)});`);
    if (ev.title) out.push(`await expect(page).toHaveTitle(${q(ev.title)});`);
  }
  return out;
}

const MOUSE_BUTTON = { secondary: 'right', auxiliary: 'middle', back: undefined, forward: undefined };

/**
 * Locator do step. Os steps do gravador da extensão já trazem o locator pronto, gerado
 * pelo próprio Playwright (step.locator, ex.: "getByRole('button', { name: 'Salvar' })").
 * Os JSONs exportados pelo DevTools Recorder trazem só step.selectors: aí usa pickLocator.
 */
function locatorOf(step, root) {
  if (step.locator) {
    const fragile = step.fragile === true || /:nth-(of-type|child)\(/.test(step.locator);
    return { code: `${root}.${step.locator}`, fragile, tag: step.tag || null };
  }
  return step.selectors ? pickLocator(step.selectors, root) : null;
}

/** Converte um step em linhas de código (sem indentação). */
export function stepToLines(step, options = {}) {
  const lines = [];
  const root = frameRoot(step);
  const loc = locatorOf(step, root);
  const timeout = step.timeout;

  if (step.target && step.target !== 'main') {
    lines.push(`// atenção: este passo aconteceu em outra aba/janela (${step.target}); ajuste para a page correta`);
  }
  if (loc && loc.fragile) {
    lines.push('// seletor frágil (posicional): o automatizador deve trocar por um locator melhor');
  }

  switch (step.type) {
    case 'setViewport':
      lines.push(`await page.setViewportSize({ width: ${step.width}, height: ${step.height} });`);
      if (step.isMobile || step.hasTouch || (step.deviceScaleFactor && step.deviceScaleFactor !== 1)) {
        lines.push(`// gravado com isMobile=${!!step.isMobile}, hasTouch=${!!step.hasTouch}, deviceScaleFactor=${step.deviceScaleFactor}: use test.use({ ...devices[...] }) se precisar`);
      }
      break;

    case 'navigate': {
      lines.push(`await page.goto(${q(step.url)}${timeout ? `, { timeout: ${timeout} }` : ''});`);
      const title = (step.assertedEvents || []).find((e) => e.type === 'navigation' && e.title)?.title;
      if (title) lines.push(`await expect(page).toHaveTitle(${q(title)});`);
      return lines;
    }

    case 'click':
    case 'doubleClick': {
      const o = opts({ button: MOUSE_BUTTON[step.button], timeout });
      lines.push(`await ${loc.code}.${step.type === 'click' ? 'click' : 'dblclick'}(${o});`);
      break;
    }

    case 'hover':
      lines.push(`await ${loc.code}.hover(${opts({ timeout })});`);
      break;

    case 'change': {
      const sensitive = isSensitive(step); // senhas são sempre mascaradas
      const value = sensitive ? "process.env.SENHA ?? ''" : q(step.value);
      if (sensitive) lines.push('// valor sensível mascarado: defina a variável de ambiente SENHA');
      const method = loc.tag === 'select' ? 'selectOption' : 'fill';
      lines.push(`await ${loc.code}.${method}(${value}${timeout ? `, { timeout: ${timeout} }` : ''});`);
      break;
    }

    case 'keyDown':
      lines.push(`await page.keyboard.down(${q(step.key)});`);
      break;

    case 'keyUp':
      lines.push(`await page.keyboard.up(${q(step.key)});`);
      break;

    case 'scroll': {
      const x = step.x || 0;
      const y = step.y || 0;
      if (loc) lines.push(`await ${loc.code}.evaluate((el) => el.scrollTo(${x}, ${y}));`);
      else lines.push(`await page.evaluate(() => window.scrollTo(${x}, ${y}));`);
      break;
    }

    case 'waitForElement': {
      const count = step.count ?? 1;
      const op = step.operator || '>=';
      const t = timeout ? `, { timeout: ${timeout} }` : '';
      if (step.visible === false) {
        lines.push(`await expect(${loc.code}).toBeHidden(${t.slice(2)});`);
      } else if (op === '==') {
        lines.push(`await expect(${loc.code}).toHaveCount(${count}${t});`);
      } else if (op === '>=' && count === 1) {
        lines.push(`await expect(${loc.code}.first()).toBeVisible(${t.slice(2)});`);
      } else {
        const matcher = op === '>=' ? 'toBeGreaterThanOrEqual' : 'toBeLessThanOrEqual';
        lines.push(`await expect.poll(() => ${loc.code}.count()${t}).${matcher}(${count});`);
      }
      for (const [name, value] of Object.entries(step.attributes || {})) {
        lines.push(`await expect(${loc.code}.first()).toHaveAttribute(${q(name)}, ${q(value)});`);
      }
      for (const [name, value] of Object.entries(step.properties || {})) {
        lines.push(`await expect(${loc.code}.first()).toHaveJSProperty(${q(name)}, ${JSON.stringify(value)});`);
      }
      return lines;
    }

    case 'waitForExpression':
      lines.push(`await ${root}.waitForFunction(${q(step.expression)}${timeout ? `, undefined, { timeout: ${timeout} }` : ''});`);
      return lines;

    case 'emulateNetworkConditions':
      lines.push('{');
      lines.push(`${INDENT}const cdp = await page.context().newCDPSession(page); // só funciona no Chromium`);
      lines.push(`${INDENT}await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: ${step.download}, uploadThroughput: ${step.upload}, latency: ${step.latency} });`);
      lines.push('}');
      return lines;

    case 'close':
      lines.push('await page.close();');
      return lines;

    case 'customStep':
      lines.push(`// passo customizado não suportado: ${step.name} ${JSON.stringify(step.parameters ?? {})}`);
      return lines;

    default:
      lines.push(`// passo não suportado (${step.type}): ${JSON.stringify(step)}`);
      return lines;
  }

  lines.push(...navigationWaits(step));
  return lines;
}

/**
 * Limpa a lista de steps antes de gerar o código:
 * - keyDown(X) seguido de keyUp(X) vira um único "press" (Enter, Tab, ...)
 * - navigate repetido para a mesma URL é descartado
 */
function normalize(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    if (s.type === 'keyDown' && next && next.type === 'keyUp' && next.key === s.key) {
      const assertedEvents = [...(s.assertedEvents || []), ...(next.assertedEvents || [])];
      out.push({ ...s, type: '__press', assertedEvents });
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    if (s.type === 'navigate' && prev && prev.type === 'navigate' && prev.url === s.url) continue;
    out.push(s);
  }
  return out;
}

function linesFor(step, options) {
  if (step.type === '__press') {
    const t = step.target && step.target !== 'main' ? [`// atenção: outra aba/janela (${step.target})`] : [];
    return [...t, `await page.keyboard.press(${q(step.key)});`, ...navigationWaits(step)];
  }
  return stepToLines(step, options);
}

/**
 * Converte a gravação inteira em um arquivo de teste Playwright.
 * @param {object|string} recording JSON exportado pelo Recorder (objeto ou texto)
 * @param {{ testName?: string }} [options]
 */
export function recordingToPlaywright(recording, options = {}) {
  const rec = typeof recording === 'string' ? JSON.parse(recording) : recording;
  if (!rec || !Array.isArray(rec.steps)) throw new Error('JSON inválido: esperado um objeto com "steps" (exportação do Recorder).');

  const body = [];
  for (const step of normalize(rec.steps)) {
    for (const line of linesFor(step, options)) body.push(INDENT + line);
  }

  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${q(options.testName || rec.title || 'gravação')}, async ({ page }) => {`,
    ...body,
    '});',
    '',
  ].join('\n');
}

/** Código de um único step (usado no "copiar passo" do Recorder). */
export function stepToPlaywright(step, options = {}) {
  return stepToLines(step, options).join('\n') + '\n';
}
