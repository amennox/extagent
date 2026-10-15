import { jest } from '@jest/globals';

jest.mock('../../../../src/agent/tools/utils', () => ({
  withActivePage: jest.fn((page: any, fn: any) => fn(page)),
  getCurrentTabId: jest.fn(() => Promise.resolve(1)),
  truncate: (s: string) => s,
  MAX_RETURN_CHARS: 100000,
  setMaxReturnChars: jest.fn(),
}));

jest.mock('../../../../src/agent/tools/stability', () => ({
  settleAfterAction: jest.fn(() => Promise.resolve('stable after 100ms')),
  waitForPageStability: jest.fn(() => Promise.resolve('stable after 100ms')),
}));

import {
  MapEntry,
  diffAlerts,
  diffMaps,
  formatEntry,
  formatMap,
  _setCurrentMap,
  browserClickRef,
  browserFillRef,
} from '../../../../src/agent/tools/pageMapTools';

const entry = (ref: number, role: string, label: string, extra: Partial<MapEntry> = {}): MapEntry => ({
  ref, role, label, candidates: [`#el-${ref}`], ...extra,
});

function createMockPage(mapEntries: Array<Omit<MapEntry, 'ref'>> = [], alerts: string[] = []) {
  return {
    url: jest.fn(() => 'https://example.com'),
    evaluate: jest.fn(() => Promise.resolve({ elements: mapEntries, alerts })),
    waitForSelector: jest.fn(() => Promise.resolve({})),
    click: jest.fn(() => Promise.resolve()),
    fill: jest.fn(() => Promise.resolve()),
  } as any;
}

describe('formatMap / formatEntry', () => {
  it('formatta ruolo, label, valore e stato', () => {
    expect(formatEntry(entry(3, 'textbox', 'Ragione sociale', { value: 'ACME' })))
      .toBe('[3] textbox "Ragione sociale" = "ACME"');
    expect(formatEntry(entry(5, 'checkbox', 'Attivo', { state: 'checked' })))
      .toBe('[5] checkbox "Attivo" (checked)');
  });

  it('gestisce mappa vuota', () => {
    expect(formatMap([])).toContain('No interactive elements');
  });
});

describe('diffMaps', () => {
  it('rileva elementi aggiunti (es. modale aperto)', () => {
    const before = [entry(1, 'button', 'Apri')];
    const after = [entry(1, 'button', 'Apri'), entry(2, 'button', 'Conferma'), entry(3, 'textbox', 'Nome')];
    const diff = diffMaps(before, after);
    expect(diff).toContain('+ [2] button "Conferma"');
    expect(diff).toContain('+ [3] textbox "Nome"');
  });

  it('rileva elementi rimossi e valori cambiati', () => {
    const before = [entry(1, 'button', 'Chiudi'), entry(2, 'textbox', 'Email', { value: '' })];
    const after = [entry(1, 'textbox', 'Email', { value: 'a@b.it' })];
    const diff = diffMaps(before, after);
    expect(diff).toContain('- button "Chiudi"');
    expect(diff).toContain('~ [1] textbox "Email" = "a@b.it"');
  });

  it('segnala assenza di cambiamenti', () => {
    const same = [entry(1, 'button', 'Salva')];
    expect(diffMaps(same, same)).toBe('no visible changes');
  });
});

describe('browser_click_ref / browser_fill_ref', () => {
  beforeEach(() => {
    _setCurrentMap({ url: 'https://example.com', entries: [entry(12, 'button', 'Salva ordine')] });
  });

  it('clicca risolvendo il ref sui candidati e riporta i cambiamenti', async () => {
    const page = createMockPage([{ role: 'button', label: 'Annulla', candidates: ['#x'] }]);
    const tool = browserClickRef(page);

    const result = await tool.func('12');

    // Acts on the exact element tagged during the scan
    expect(page.click).toHaveBeenCalledWith('[data-dm-ref="12"]', expect.any(Object));
    expect(result).toContain('Clicked [12] button "Salva ordine"');
    expect(result).toContain('Changes:');
  });

  it('errore chiaro per ref inesistente', async () => {
    const page = createMockPage();
    const tool = browserClickRef(page);
    const result = await tool.func('99');
    expect(result).toContain('ref [99] not found');
  });

  it('errore chiaro senza mappa', async () => {
    _setCurrentMap(null);
    const page = createMockPage();
    const tool = browserClickRef(page);
    const result = await tool.func('1');
    expect(result).toContain('Call browser_observe first');
  });

  it('espone i nuovi messaggi di pagina (toast/errori) nel risultato dell\'azione', async () => {
    _setCurrentMap({ url: 'https://example.com', entries: [entry(98, 'button', 'Salva')], alerts: [] });
    const page = createMockPage([{ role: 'button', label: 'Salva', candidates: ['#s'] }], ['La data di pubblicazione è obbligatoria']);
    const tool = browserClickRef(page);

    const result = await tool.func('98');

    expect(result).toContain('PAGE MESSAGES');
    expect(result).toContain('La data di pubblicazione è obbligatoria');
  });

  it('diffAlerts restituisce solo i messaggi nuovi', () => {
    expect(diffAlerts(['già presente'], ['già presente', 'Errore: campo mancante'])).toEqual(['Errore: campo mancante']);
    expect(diffAlerts([], [])).toEqual([]);
  });

  it('fill_ref usa page.fill con il testo dopo il separatore', async () => {
    _setCurrentMap({ url: 'https://example.com', entries: [entry(7, 'textbox', 'Ragione sociale')] });
    const page = createMockPage([]);
    const tool = browserFillRef(page);

    const result = await tool.func('7|Rossi | Bianchi SRL');

    expect(page.fill).toHaveBeenCalledWith('[data-dm-ref="7"]', 'Rossi | Bianchi SRL', expect.any(Object));
    expect(result).toContain('Filled [7]');
  });
});

describe('formatScrollInfo / formatObservation', () => {
  it('says what is above/below the fold and behind dialogs', () => {
    const { formatScrollInfo, formatObservation } = require('../../../../src/agent/tools/pageMapTools');
    expect(formatScrollInfo({ scroll: { scrollTop: 0, scrollHeight: 3000, clientHeight: 750, inner: false }, below: 12, above: 0 }))
      .toBe('Viewport shows 0–25% of the page · 12 more interactive elements BELOW (browser_scroll down to see them)');
    expect(formatScrollInfo({ scroll: { scrollTop: 0, scrollHeight: 700, clientHeight: 750, inner: false }, covered: 4 }))
      .toBe('Whole page fits in the viewport · 4 hidden behind the open dialog');
    const text = formatObservation({ url: 'https://x.it/a', title: 'A', entries: [entry(3, 'link', 'Home')], alerts: ['Salvato'] });
    expect(text).toContain('Page: "A" https://x.it/a');
    expect(text).toContain('[3] link "Home"');
    expect(text).toContain('! Salvato');
  });
});

describe('parse inputs', () => {
  beforeEach(() => {
    _setCurrentMap({ url: 'https://example.com', entries: [entry(7, 'textbox', 'Ragione sociale')] });
  });

  it('fill_ref accepts JSON args with submit (presses Enter after filling)', async () => {
    const page = createMockPage([]);
    (page as any).press = jest.fn(() => Promise.resolve());
    const result = await browserFillRef(page).func(JSON.stringify({ ref: 7, text: 'ACME', submit: true }));
    expect(page.fill).toHaveBeenCalledWith('[data-dm-ref="7"]', 'ACME', expect.any(Object));
    expect((page as any).press).toHaveBeenCalledWith('[data-dm-ref="7"]', 'Enter', expect.any(Object));
    expect(result).toContain('and pressed Enter');
  });

  it('click_ref accepts {"ref": n}', async () => {
    _setCurrentMap({ url: 'https://example.com', entries: [entry(12, 'button', 'Salva ordine')] });
    const page = createMockPage([]);
    await browserClickRef(page).func('{"ref": 12}');
    expect(page.click).toHaveBeenCalledWith('[data-dm-ref="12"]', expect.any(Object));
  });
});
