import { classifySignals, playbookFor, profileSummary, PageSignals } from '../../../src/agent/pageProfiler';

const baseSignals: PageSignals = {
  hasReactHook: false,
  hasReactAttrs: false,
  ngVersion: false,
  hasVue: false,
  hasJquery: false,
  historyApiSpa: false,
  classSample: '',
  iframes: 0,
  shadowRoots: 0,
  divRoleButtons: 0,
  nativeButtons: 10,
  virtualScrollHints: false,
};

describe('classifySignals', () => {
  it('classifica React SPA', () => {
    const p = classifySignals({ ...baseSignals, hasReactHook: true, historyApiSpa: true });
    expect(p.framework).toBe('react');
    expect(p.spa).toBe(true);
  });

  it('classifica Angular', () => {
    const p = classifySignals({ ...baseSignals, ngVersion: true, historyApiSpa: true });
    expect(p.framework).toBe('angular');
  });

  it('classifica server-rendered in assenza di segnali', () => {
    const p = classifySignals(baseSignals);
    expect(p.framework).toBe('server-rendered');
    expect(p.spa).toBe(false);
  });

  it('rileva UI kit dalle classi', () => {
    const p = classifySignals({ ...baseSignals, classSample: 'btn btn-primary form-control select2-container' });
    expect(p.uiKits).toContain('Bootstrap');
    expect(p.uiKits).toContain('select2');
  });

  it('rileva Radix/shadcn dal marker (backoffice tipo h4h)', () => {
    const p = classifySignals({ ...baseSignals, hasReactHook: true, historyApiSpa: true, classSample: 'flex h-10 w-full __radix-shadcn__' });
    expect(p.framework).toBe('react');
    expect(p.uiKits).toContain('Radix/shadcn');
    // Il playbook deve vietare select_ref sui combobox custom
    const pb = playbookFor(p, 'it');
    expect(pb).toContain('MAI browser_select_ref');
  });

  it('rileva controlli form custom (div role=button prevalenti)', () => {
    const p = classifySignals({ ...baseSignals, divRoleButtons: 20, nativeButtons: 4 });
    expect(p.customFormControls).toBe(true);
  });

  it('rileva shadow DOM e iframe', () => {
    const p = classifySignals({ ...baseSignals, shadowRoots: 3, iframes: 2 });
    expect(p.shadowDom).toBe(true);
    expect(p.iframes).toBe(2);
  });
});

describe('playbookFor / profileSummary', () => {
  it('per una React SPA include il divieto di waitForNavigation e gli input controllati', () => {
    const p = classifySignals({ ...baseSignals, hasReactHook: true, historyApiSpa: true });
    const pb = playbookFor(p, 'it');
    expect(pb).toContain('browser_wait_for_navigation');
    expect(pb).toContain('browser_fill_ref');
  });

  it('per server-rendered non include hint SPA', () => {
    const p = classifySignals(baseSignals);
    const pb = playbookFor(p, 'en');
    expect(pb).not.toContain('SPA:');
  });

  it('summary compatta', () => {
    const p = classifySignals({ ...baseSignals, hasReactHook: true, historyApiSpa: true, classSample: 'css-1abc-MuiButton-root', iframes: 1 });
    const s = profileSummary(p);
    expect(s).toContain('react SPA');
    expect(s).toContain('MUI');
    expect(s).toContain('1 iframe');
  });

  it('playbook bilingue', () => {
    const p = classifySignals({ ...baseSignals, hasVue: true, historyApiSpa: true });
    expect(playbookFor(p, 'it')).toContain('Struttura rilevata');
    expect(playbookFor(p, 'en')).toContain('Detected structure');
  });
});
