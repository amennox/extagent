import { approvalReason } from '../../../src/agent/approvalPolicy';

const entry = (label: string, role = 'button') => ({ ref: 1, role, label, candidates: [] });

describe('approvalPolicy', () => {
  it('asks before deletions, payments, sending and final confirmations (risky mode)', () => {
    for (const label of ['Elimina record', 'Delete', 'Paga ora', 'Acquista', 'Invia richiesta', 'Conferma ordine', 'Place order']) {
      expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'risky', entry: entry(label) })).toMatch(/irreversible/);
    }
  });

  it('does not ask for ordinary navigation, saves or tabs in risky mode', () => {
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'risky', entry: entry('Salva') })).toBeNull();
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'risky', entry: entry('Avanti', 'link') })).toBeNull();
    // A tab named "Pagamento" is navigation, not a payment
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'risky', entry: entry('Pagamento *', 'tab') })).toBeNull();
    expect(approvalReason('browser_fill_ref', { ref: 1, text: 'x', submit: true }, { mode: 'risky', entry: entry('Cerca', 'textbox') })).toBeNull();
  });

  it('strict mode also covers saves and Enter submissions', () => {
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'strict', entry: entry('Salva') })).not.toBeNull();
    expect(approvalReason('browser_press_key', { key: 'Enter' }, { mode: 'strict' })).toMatch(/Enter/);
  });

  it('off mode never asks; always-approve tools always ask otherwise', () => {
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'off', entry: entry('Elimina') })).toBeNull();
    expect(approvalReason('clear_all_memories', {}, { mode: 'risky' })).not.toBeNull();
    expect(approvalReason('browser_tab', { action: 'close', index: 1 }, { mode: 'risky' })).not.toBeNull();
  });

  it('keeps the model flag as an extra signal', () => {
    expect(approvalReason('browser_click_ref', { ref: 1 }, { mode: 'risky', entry: entry('Avanti'), modelFlag: true })).not.toBeNull();
  });
});
