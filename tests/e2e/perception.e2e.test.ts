/**
 * @jest-environment node
 */
import type { Browser } from 'playwright-core';
import {
  browserObserve, browserClickRef, browserFillRef, browserSelectRef, browserScroll,
  getCurrentMap, setVisionEnabled,
} from '../../src/agent/tools/pageMapTools';
import { setCurrentPage, resetPageContext } from '../../src/agent/PageContextManager';
import { describeIfChromium, launch, openFixture } from './helpers';

function refOf(label: string): number {
  const e = getCurrentMap()!.entries.find(x => x.label.includes(label));
  if (!e) throw new Error(`no entry with label ${label}: ${getCurrentMap()!.entries.map(x => x.label).join(' | ')}`);
  return e.ref;
}

describeIfChromium('perception on real Chromium', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); }, 30000);
  afterAll(async () => { await browser?.close(); });
  afterEach(() => { resetPageContext(); setVisionEnabled(false); });

  async function open(name: string) {
    const page = await openFixture(browser, name);
    setCurrentPage(page as any);
    return page as any;
  }

  it('maps fields with labels, required state and tabs; fills and saves a multi-tab form', async () => {
    const page = await open('form.html');
    const obs = await browserObserve(page).func('');
    expect(obs.text).toContain('textbox "Ragione sociale"');
    expect(obs.text).toContain('(required)');
    expect(obs.text).toContain('tab "Pagamento *"');
    expect(obs.text).not.toContain('rs-hidden');

    await browserFillRef(page).func(JSON.stringify({ ref: refOf('Ragione sociale'), text: 'ACME srl' }));
    await browserFillRef(page).func(`${refOf('Partita IVA')}|01234567890`);
    const sel = await browserSelectRef(page).func(JSON.stringify({ ref: refOf('Seleziona'), option: 'Consulenza' }));
    expect(sel).toContain('custom dropdown');
    const tabRes = await browserClickRef(page).func(String(refOf('Pagamento')));
    expect(tabRes).toContain('+ [');
    expect(tabRes).toContain('IBAN');
    await browserFillRef(page).func(JSON.stringify({ ref: refOf('IBAN'), text: 'IT60X0542811101000000123456' }));
    await browserSelectRef(page).func(JSON.stringify({ ref: refOf('Termini'), option: '60 giorni' }));
    await browserClickRef(page).func(String(refOf('Salva')));
    expect(await page.textContent('#result')).toBe('Salvato: ACME srl / Consulenza / 60');
  }, 30000);

  it('surfaces native validation errors after a blocked save', async () => {
    const page = await open('form.html');
    await browserObserve(page).func('');
    const res = await browserClickRef(page).func(String(refOf('Salva')));
    // Native constraint validation blocks the submit with a browser bubble
    // that is not in the DOM: it must still reach the model.
    expect(res).toContain('PAGE MESSAGES');
    expect(res).toContain('Field "Ragione sociale"');
    expect(res).toContain('invalid');
  }, 30000);

  it('reports content below the fold and scrolls to it', async () => {
    const page = await open('long.html');
    const obs = await browserObserve(page).func('');
    expect(obs.text).toMatch(/BELOW/);
    expect(obs.text).not.toContain('Carica altri');
    const after = await browserScroll(page).func(JSON.stringify({ direction: 'bottom' }));
    expect(after.text).toContain('Scrolled bottom');
    expect(after.text).toContain('Carica altri');
    await browserClickRef(page).func(String(refOf('Carica altri')));
    expect(await page.textContent('#done')).toBe('Caricati altri ordini');
  }, 30000);

  it('scrolls an inner scroll container', async () => {
    const page = await open('inner-scroll.html');
    const obs = await browserObserve(page).func('');
    expect(obs.text).toContain('inner scroll container');
    expect(obs.text).not.toContain('In fondo');
    const after = await browserScroll(page).func('down');
    const after2 = await browserScroll(page).func('bottom');
    expect(after.text + after2.text).toContain('In fondo');
  }, 30000);

  it('hides elements behind an open modal', async () => {
    const page = await open('modal.html');
    await browserObserve(page).func('');
    const res = await browserClickRef(page).func(String(refOf('Elimina record')));
    expect(res).toContain('Conferma');
    const obs = await browserObserve(page).func('');
    expect(obs.text).toContain('hidden behind the open dialog');
    expect(obs.text).not.toContain('Link sotto');
    await browserClickRef(page).func(String(refOf('Conferma')));
    expect(await page.evaluate(() => document.body.dataset.deleted)).toBe('1');
  }, 30000);

  it('acts inside iframes', async () => {
    const page = await open('frames.html');
    const obs = await browserObserve(page).func('');
    expect(obs.text).toContain('[iframe]');
    await browserFillRef(page).func(JSON.stringify({ ref: refOf('Codice'), text: 'ABC123' }));
    await browserClickRef(page).func(String(refOf('Cerca')));
    const frame = page.frames()[1];
    expect(await frame.evaluate(() => document.body.dataset.ok)).toBe('ABC123');
  }, 30000);

  it('acts inside open shadow roots', async () => {
    const page = await open('shadow.html');
    await browserObserve(page).func('');
    await browserFillRef(page).func(JSON.stringify({ ref: refOf('Nome'), text: 'Mario' }));
    await browserClickRef(page).func(String(refOf('Invia richiesta')));
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe('Mario');
  }, 30000);

  it('returns a Set-of-Marks screenshot when vision is enabled, and removes the overlay', async () => {
    const page = await open('form.html');
    setVisionEnabled(true);
    const obs = await browserObserve(page).func('');
    expect(obs.image?.mediaType).toBe('image/jpeg');
    expect(obs.image!.data.length).toBeGreaterThan(1000);
    expect(obs.text).toContain('Screenshot attached');
    expect(await page.evaluate(() => !!document.getElementById('__dommotion_marks__'))).toBe(false);
  }, 30000);
});

describeIfChromium('stable refs', () => {
  it('keeps the same number for an element across rescans and actions on the same page', async () => {
    const browser = await launch();
    try {
      const page = await openFixture(browser, 'form.html') as any;
      setCurrentPage(page);
      await browserObserve(page).func('');
      const saveRef = refOf('Salva');
      const ivaRef = refOf('Partita IVA');
      const res = await browserSelectRef(page).func(JSON.stringify({ ref: refOf('Seleziona'), option: 'Servizi IT' }));
      expect(res).toContain('Selected');
      await browserClickRef(page).func(String(refOf('Pagamento')));
      await browserClickRef(page).func(String(refOf('Anagrafica')));
      expect(refOf('Salva')).toBe(saveRef);
      expect(refOf('Partita IVA')).toBe(ivaRef);
    } finally {
      await browser.close();
      resetPageContext();
    }
  }, 30000);
});
