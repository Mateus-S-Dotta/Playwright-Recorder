// Registra o formato "Playwright" no painel Recorder do DevTools.
// Aparece em: Recorder → botão de exportar (seta) → "Playwright Test",
// e também no seletor de código do painel lateral ("Show code").
import { recordingToPlaywright, stepToPlaywright } from './converter.js';

class PlaywrightPlugin {
  async stringify(recording) {
    return recordingToPlaywright(recording);
  }

  async stringifyStep(step) {
    return stepToPlaywright(step);
  }
}

if (chrome.devtools?.recorder?.registerRecorderExtensionPlugin) {
  chrome.devtools.recorder.registerRecorderExtensionPlugin(
    new PlaywrightPlugin(),
    'Playwright Test',
    'text/javascript',
  );
} else {
  console.warn('[Recorder → Playwright] chrome.devtools.recorder indisponível (precisa do Chrome 104+).');
}
