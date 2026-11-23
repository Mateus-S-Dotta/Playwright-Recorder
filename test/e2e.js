// Teste ponta a ponta da extensão: carrega no Chromium, grava interações numa página
// local, finaliza a gravação e roda o teste Playwright gerado contra a mesma página.
// Rodar: ./npm.sh run test:extension:e2e
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));
const PORT = 4567;
const BASE = `http://localhost:${PORT}`;

const PAGES = {
  '/': `<!doctype html><title>Loja Teste</title>
    <form id="login" onsubmit="event.preventDefault(); location.href='/painel'">
      <label>E-mail <input id="email" name="email"></label>
      <label>Senha <input id="senha" name="senha" type="password"></label>
      <select id="uf"><option value="">--</option><option value="SP">São Paulo</option></select>
      <label><input type="checkbox" id="termos"> Aceito os termos</label>
      <button type="submit">Entrar</button>
    </form>`,
  '/painel': `<!doctype html><title>Painel</title>
    <h1>Painel</h1>
    <button onclick="document.getElementById('msg').textContent='Salvo!'"><span>Salvar</span></button>
    <p id="msg"></p>
    <a href="/painel/detalhes">Ver detalhes</a>`,
  '/painel/detalhes': `<!doctype html><title>Detalhes</title><h1>Detalhes</h1>`,
};

const server = createServer((req, res) => {
  const html = PAGES[req.url.split('?')[0]];
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html || 'not found');
}).listen(PORT);

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', // Chromium completo (o headless-shell não carrega extensões)
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // o service worker aparece antes de terminar de carregar o background.js
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.__gravador)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = context.pages()[0] || await context.newPage();
  await page.goto(BASE + '/');

  // = clicar no ícone da extensão
  const toggle = () => sw.evaluate(async (base) => {
    const [tab] = await chrome.tabs.query({ url: base + '/*' });
    return globalThis.__gravador.toggle(tab);
  }, BASE);

  await toggle();
  await page.waitForTimeout(500);

  await page.click('#email');
  await page.keyboard.type('ana@teste.com');
  await page.click('#senha');
  await page.keyboard.type('minha-senha-secreta');
  await page.focus('#uf');
  await page.keyboard.press('ArrowDown');
  await page.click('text=Aceito os termos');
  await page.click('button[type=submit]');
  await page.waitForURL(BASE + '/painel');
  await page.waitForTimeout(500);
  await page.click('button span');
  await page.click('text=Ver detalhes');
  await page.waitForURL(BASE + '/painel/detalhes');
  await page.waitForTimeout(500);

  const code = await toggle();
  console.log(code);

  assert.ok(code, 'a gravação deveria devolver código');
  assert.doesNotMatch(code, /minha-senha-secreta/, 'a senha não pode aparecer no código');
  assert.match(code, /fill\(process\.env\.SENHA \?\? ''\)/);
  // locators no formato do codegen do Playwright (a extensão usa o mesmo gerador)
  const has = (line) => assert.ok(code.includes(line), `esperado no código gerado: ${line}`);
  has("await page.getByRole('textbox', { name: 'E-mail' }).fill('ana@teste.com');");
  has("await page.getByRole('textbox', { name: 'Senha' }).fill(process.env.SENHA ?? '');");
  has("await page.locator('#uf').selectOption('SP');");
  has("await page.getByRole('checkbox', { name: 'Aceito os termos' }).click();");
  has("await page.getByRole('button', { name: 'Entrar' }).click();");
  has("await page.waitForURL('http://localhost:4567/painel');");
  // clique no <span> dentro do <button>: o gerador sobe até o botão
  has("await page.getByRole('button', { name: 'Salvar' }).click();");
  has("await page.getByRole('link', { name: 'Ver detalhes' }).click();");
  assert.doesNotMatch(code, /seletor frágil/, 'nenhum seletor deveria cair no CSS posicional');

  // roda o teste gerado com o servidor ainda no ar
  mkdirSync(TMP, { recursive: true });
  writeFileSync(TMP + 'gravado.spec.js', code);
  writeFileSync(TMP + 'playwright.config.js', "export default { testDir: '.', reporter: 'list', use: { trace: 'off' } };\n");
  // assíncrono: o servidor HTTP acima roda neste mesmo processo
  const status = await new Promise((resolve) => {
    spawn('npx', ['playwright', 'test', '-c', TMP + 'playwright.config.js'], { stdio: 'inherit', env: { ...process.env, SENHA: 'x' } })
      .on('exit', resolve);
  });
  assert.equal(status, 0, 'o teste gerado falhou');
  console.log('\n✔ teste gerado pela extensão passou');
} finally {
  await context.close();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
