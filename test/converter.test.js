// Testes do conversor. Rodar: ./npm.sh run test:extension
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordingToPlaywright, stepToPlaywright, pickLocator } from '../converter.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/jsonplaceholder.json', import.meta.url), 'utf8'));

test('converte a gravação de exemplo', () => {
  const code = recordingToPlaywright(fixture);
  console.log(code);
  assert.match(code, /^import \{ test, expect \} from '@playwright\/test';/);
  assert.match(code, /test\('1237561', async \(\{ page \}\) => \{/);
  assert.match(code, /page\.setViewportSize\(\{ width: 996, height: 791 \}\)/);
  assert.match(code, /getByRole\('link', \{ name: 'Blog', exact: true \}\)\.click\(\)/);
  assert.match(code, /getByRole\('link', \{ name: 'Guide', exact: true \}\)\.click\(\)/);
  assert.match(code, /locator\('#tab-filter'\)\.click\(\)/);
  assert.match(code, /seletor frágil/);
  // os dois navigate iniciais para a mesma URL viram um só
  assert.equal(code.split("page.goto('https://jsonplaceholder.typicode.com/')").length - 1, 2);
});

test('keyDown + keyUp viram press; senha é mascarada; select usa selectOption', () => {
  const code = recordingToPlaywright({
    title: 'login',
    steps: [
      { type: 'change', value: 'segredo', selectors: [['aria/Senha'], ['#password']] },
      { type: 'change', value: 'SP', selectors: [['select#uf']] },
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: 'Enter', assertedEvents: [{ type: 'navigation', url: 'https://x/home', title: 'Home' }] },
    ],
  });
  assert.match(code, /\.fill\(process\.env\.SENHA \?\? ''\)/);
  assert.doesNotMatch(code, /segredo/);
  assert.match(code, /locator\('select#uf'\)\.selectOption\('SP'\)/);
  assert.match(code, /page\.keyboard\.press\('Enter'\)/);
  assert.match(code, /page\.waitForURL\('https:\/\/x\/home'\)/);
});

test('campo marcado como sensível pelo gravador sempre vira process.env.SENHA', () => {
  const code = stepToPlaywright({ type: 'change', value: '', sensitive: true, selectors: [['#campo3']] });
  assert.equal(code, "// valor sensível mascarado: defina a variável de ambiente SENHA\nawait page.locator('#campo3').fill(process.env.SENHA ?? '');\n");
});

test('seletores especiais', () => {
  assert.equal(pickLocator([['[data-testid="salvar"]']]).code, "page.getByTestId('salvar')");
  assert.equal(pickLocator([['pierce/my-el', 'button.ok']]).code, "page.locator('my-el').locator('button.ok')");
  assert.equal(pickLocator([['xpath///div[2]']]).code, "page.locator('xpath=//div[2]')");
  assert.equal(pickLocator([["text/It's ok"]]).code, "page.getByText('It\\'s ok', { exact: true })");
  assert.equal(pickLocator([['aria/Nome'], ['form > input:nth-of-type(1)']]).code, "page.getByRole('textbox', { name: 'Nome', exact: true })");
});

test('step do gravador usa o locator gerado pelo Playwright', () => {
  assert.equal(
    stepToPlaywright({ type: 'click', selector: 'internal:role=button[name="Salvar"i]', locator: "getByRole('button', { name: 'Salvar' })", tag: 'span' }),
    "await page.getByRole('button', { name: 'Salvar' }).click();\n",
  );
  assert.equal(
    stepToPlaywright({ type: 'change', value: 'SP', locator: "getByLabel('UF')", tag: 'select', frame: [1] }),
    "await page.mainFrame().childFrames()[1].getByLabel('UF').selectOption('SP');\n",
  );
  assert.match(
    stepToPlaywright({ type: 'click', locator: "locator('div > span:nth-of-type(2)')", tag: 'span' }),
    /seletor frágil/,
  );
});

test('waitForElement, iframe e passo único', () => {
  const code = stepToPlaywright({ type: 'waitForElement', selectors: [['#lista li']], count: 3, operator: '==', frame: [0] });
  assert.equal(code, "await expect(page.mainFrame().childFrames()[0].locator('#lista li')).toHaveCount(3);\n");
});

test('JSON inválido gera erro legível', () => {
  assert.throws(() => recordingToPlaywright({ foo: 1 }), /steps/);
});
