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

- Versão embutida: a do `@playwright/test` no `package.json` (hoje **1.52.0**).
- Atualizar (opcional, quando quiser as melhorias de uma versão nova): troque a versão no
  `package.json`/`Dockerfile`, rode `./npm.sh install`, `./npm.sh run build:extension` e
  `./npm.sh run test:extension:e2e`. O script usa código interno do Playwright; se a estrutura
  mudar, ele avisa com um erro em vez de gerar um arquivo quebrado.
- O nome acessível depende do idioma do navegador (ex.: um botão do framework pode se chamar
  "Excluir" em pt-BR e "Delete" em en-US). Rode o teste com o mesmo `locale` usado na gravação.

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
