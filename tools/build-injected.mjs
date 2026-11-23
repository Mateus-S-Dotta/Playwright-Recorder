// Gera extension/vendor/playwright-injected.js a partir do playwright-core instalado.
// É o mesmo "InjectedScript" que o Playwright injeta nas páginas: ele contém o gerador
// de seletores do codegen (generateSelector) e o conversor para código (asLocator).
//
// O arquivo gerado fica versionado junto com a extensão, então só precisa rodar de novo
// quando quiser atualizar a versão do Playwright embutida:
//   ./npm.sh run build:extension
//
// Atenção: usa código interno do Playwright (lib/generated/injectedScriptSource.js e a
// assinatura do construtor do InjectedScript). Ao trocar de versão, rode
// `./npm.sh run test:extension:e2e` para confirmar que continua funcionando.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// o "exports" do pacote não expõe lib/generated: carrega pelo caminho físico
const pkgDir = dirname(require.resolve('playwright-core/package.json'));
const { version } = require(join(pkgDir, 'package.json'));
const { source } = require(join(pkgDir, 'lib/generated/injectedScriptSource.js'));

if (!source.includes('generateSelector(targetElement, options)') || !source.includes('asLocator,')) {
  throw new Error(`playwright-core@${version}: o InjectedScript mudou (generateSelector/utils.asLocator não encontrados). Ajuste este script.`);
}

const out = fileURLToPath(new URL('../vendor/playwright-injected.js', import.meta.url));
mkdirSync(fileURLToPath(new URL('../vendor/', import.meta.url)), { recursive: true });

writeFileSync(out, `// ARQUIVO GERADO por extension/tools/build-injected.mjs — não edite à mão.
// Origem: playwright-core@${version} (lib/generated/injectedScriptSource.js)
// Copyright (c) Microsoft Corporation. Licenciado sob a Apache License 2.0:
// https://github.com/microsoft/playwright/blob/main/LICENSE
//
// Expõe globalThis.__pwGravador.create(testIdAttributeName) → InjectedScript, usado pelo
// recorder.js para gerar os mesmos locators que o codegen do Playwright.
(() => {
  if (globalThis.__pwGravador) return;
  // o código do Playwright roda num escopo próprio para não colidir com os nomes abaixo
  const PlaywrightInjectedScript = (() => {
    const module = {};
${source}
    return module.exports.InjectedScript();
  })();
  globalThis.__pwGravador = {
    version: ${JSON.stringify(version)},
    // mesmos argumentos que o Playwright usa em server/dom.js (injectedScript())
    create: (testIdAttributeName = 'data-testid') => new PlaywrightInjectedScript(
      window,
      false,          // isUnderTest
      'javascript',   // sdkLanguage
      testIdAttributeName,
      1,              // stableRafCount
      'chromium',     // browserName
      false,          // inputFileRoleTextbox
      [],             // customEngines
    ),
  };
})();
`);

// falha aqui (e não no navegador) se o arquivo gerado não for JavaScript válido
new Script(readFileSync(out, 'utf8'), { filename: out });

console.log(`✔ extension/vendor/playwright-injected.js gerado (playwright-core@${version})`);
