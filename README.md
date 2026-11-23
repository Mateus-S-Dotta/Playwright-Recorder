# Extensão Gravador Playwright

Grava o que você faz numa aba e baixa um teste **Playwright** pronto.

## Instalar (modo desenvolvedor)
1. Abra `chrome://extensions` (ou `edge://extensions`) e ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione esta pasta `extension/`.
3. Fixe o ícone na barra (ícone de quebra-cabeça → alfinete).

## Usar
| Ícone | Estado | Clique |
|---|---|---|
| ▶ verde | parado | começa a gravar a aba atual |
| ● cinza com ponto vermelho | gravando | finaliza e baixa `gravacao-<titulo>-<data>.spec.ts` + o vídeo (`.mp4`, ou `.webm` em Chrome < 126) |

- **Vídeo**: grava o conteúdo da aba (não a tela inteira) do início ao fim, inclusive ao trocar
  de página, com o som da aba. Enquanto grava, o Chrome mostra um indicador de captura na aba.
  Se a captura não for possível, os passos são gravados normalmente, só sem o vídeo.

- Grava cliques, duplo clique, preenchimento de campos, selects, teclas (Enter, Tab, Esc, setas,
  atalhos) e navegações (link → `waitForURL`, URL digitada/voltar → `goto`).
- Continua gravando ao trocar de página e dentro de iframes.
- **Senhas nunca são gravadas**: campos `type="password"` viram `process.env.SENHA` e o valor
  digitado não sai da página.
- Fechar a aba que está gravando também finaliza e baixa o arquivo.
- Bônus: no DevTools → *Recorder*, a exportação **Playwright Test** usa o mesmo conversor.

## Seletores iguais aos do Playwright
Os locators são gerados pelo **próprio código do Playwright**: o mesmo gerador que o
`npx playwright codegen` usa (`getByTestId` > `getByRole` > `getByLabel`/`getByPlaceholder`/`getByText` > CSS).
Ele fica embutido em `vendor/playwright-injected.js`, então a extensão não depende do Playwright
instalado na máquina e o código gerado (API pública `getBy*`) roda em qualquer versão recente.

- **Versão embutida:** está escrita na 2ª linha de `vendor/playwright-injected.js`
  (ex.: `// Origem: playwright-core@1.52.0`).
- **O que é esse arquivo:** `vendor/playwright-injected.js` = **código original do Playwright, sem
  nenhuma alteração + uma embalagem de ~20 linhas** para a extensão conseguir usá-lo.
  - *Código original:* o conteúdo inteiro de
    `node_modules/playwright-core/lib/generated/injectedScriptSource.js` (o *InjectedScript*),
    que é o código que o próprio Playwright injeta nas páginas e que o `codegen` usa para
    escolher os seletores.
  - *Embalagem:* um cabeçalho (origem, versão, licença Apache 2.0 da Microsoft), um escopo
    isolado para os nomes do Playwright não colidirem com os da página, e um atalho
    `globalThis.__pwGravador.create()` que instancia o InjectedScript com os mesmos parâmetros
    que o Playwright usa internamente. É por esse atalho que o `recorder.js` pede os seletores.
  - *Por que a embalagem:* normalmente quem injeta esse código é o Playwright; como a extensão
    roda sem o Playwright, ela mesma injeta.
- Para trocar a versão, veja [Atualizar o Playwright embutido](#atualizar-o-playwright-embutido-passo-a-passo).
- O nome acessível depende do idioma do navegador (ex.: um botão do framework pode se chamar
  "Excluir" em pt-BR e "Delete" em en-US). Rode o teste com o mesmo `locale` usado na gravação.

## Atualizar o Playwright embutido (passo a passo)
**É opcional.** A extensão funciona do jeito que está. Só faça isso se quiser os seletores de uma
versão mais nova do Playwright. Ninguém edita nem cola o arquivo à mão: um script faz tudo.

### O que você precisa ter
- **Node.js 18 ou mais novo.** Para conferir, abra um terminal e rode `node -v`. Se aparecer algo
  como `v20.11.0`, está ok. Se der *"node não é reconhecido"*, instale o Node em
  [nodejs.org](https://nodejs.org) (versão LTS), feche e abra o terminal de novo.
- **Internet** (o `npm` baixa o pacote).
- **Não precisa** de um projeto Playwright, nem de testes, nem de navegadores do Playwright
  instalados. Só do pacote `playwright-core`, que o passo 3 instala.

### Em qual pasta rodar
Rode tudo na **pasta que contém a pasta `extension/`** (a pasta "mãe" dela). Exemplo:

```
meu-projeto/              ← abra o terminal AQUI
├── extension/            ← esta extensão
│   ├── manifest.json
│   ├── tools/build-injected.mjs
│   └── vendor/playwright-injected.js
└── node_modules/         ← aparece aqui depois do passo 3
    └── playwright-core/
```

Por que essa pasta: o script procura o `playwright-core` numa pasta `node_modules` que esteja
**dentro da pasta da extensão ou em qualquer pasta acima dela** (mãe, avó, …). Instalar na pasta mãe
funciona e não enche a pasta da extensão com arquivos que o Chrome carregaria à toa.

> Se o `node_modules` estiver em outro lugar (uma pasta "irmã", por exemplo), o script **não
> encontra** o pacote. A pasta em que o terminal está não importa para o script, só a posição do
> `node_modules` em relação à pasta `extension/`.

### Comandos
1. Abra o terminal na pasta mãe. No VS Code: clique com o botão direito na pasta mãe →
   *Open in Integrated Terminal*. Ou use `cd caminho/da/pasta-mae`.
2. (Opcional) Veja qual é a versão mais nova:
   ```
   npm view playwright-core version
   ```
3. Instale a versão desejada (troque `1.53.0` pela versão que quiser; `latest` = a mais nova):
   ```
   npm install playwright-core@1.53.0
   ```
   Isso cria a pasta `node_modules/` (e um `package.json`, se ainda não existir) na pasta mãe.
4. Gere o arquivo novo:
   ```
   node extension/tools/build-injected.mjs
   ```
   Deu certo se aparecer:
   `✔ extension/vendor/playwright-injected.js gerado (playwright-core@1.53.0)`.
   O arquivo antigo é substituído automaticamente.
5. Abra `chrome://extensions` e clique no **↻** (recarregar) do card da extensão.
6. Grave algo rápido e confira se o teste baixado está com seletores normais.

Depois disso, a pasta `node_modules/` pode ser apagada se você quiser. A extensão não precisa
dela, só o passo 4 precisa.

### Se der erro
| Mensagem | O que fazer |
|---|---|
| `node não é reconhecido…` / `command not found: node` | Instale o Node (veja acima) e abra um terminal novo. |
| `Cannot find module 'playwright-core/package.json'` | O `playwright-core` não está numa pasta acima de `extension/`. Confira se você rodou o passo 3 na pasta mãe. |
| `Cannot find module '…/extension/tools/build-injected.mjs'` | O terminal não está na pasta mãe. Rode `cd` até ela, ou ajuste o caminho do comando. |
| `o InjectedScript mudou (generateSelector/utils.asLocator não encontrados)` | Essa versão do Playwright mudou o código interno que o script usa. Nada foi alterado na extensão. Volte para a versão anterior (`npm install playwright-core@<versão antiga>`) ou peça para alguém ajustar o `tools/build-injected.mjs`. |
## Arquivos
| Arquivo | Papel |
|---|---|
| `background.js` | Service worker: ícone, iniciar/finalizar, navegações, download |
| `offscreen.html` / `offscreen.js` | Grava o vídeo da aba (MediaRecorder), pois o service worker não tem acesso a mídia |
| `recorder.js` | Content script: captura as ações e pede os locators ao gerador do Playwright |
| `vendor/playwright-injected.js` | **Gerado** — InjectedScript do Playwright (gerador de seletores). Não editar |
| `tools/build-injected.mjs` | Gera o arquivo acima a partir do `playwright-core` (`./npm.sh run build:extension`) |
| `converter.js` | Steps gravados / JSON do Recorder → código Playwright (sem dependências) |
| `devtools.js` | Registra o formato no painel Recorder do DevTools |
| `test/` | `./npm.sh run test:extension` (conversor) e `./npm.sh run test:extension:e2e` (extensão no Chromium, grava e roda o teste gerado) |

## Limitações
- Não grava em páginas internas (`chrome://`, Chrome Web Store) nem em abas novas abertas por
  `target="_blank"`.
- Rolagem e hover não são gravados (o Playwright rola sozinho até o elemento).
