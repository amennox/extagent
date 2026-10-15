import { ActionLog } from '../../../src/tracking/actionLog';

describe('ActionLog', () => {
  beforeEach(() => ActionLog.reset());

  it('registra i passi in ordine', () => {
    ActionLog.push({ type: 'navigate', url: 'https://a.it' });
    ActionLog.push({ type: 'click', selector: '#b' });
    expect(ActionLog.size()).toBe(2);
    expect(ActionLog.snapshot().map(s => s.type)).toEqual(['navigate', 'click']);
  });

  it('unisce type consecutivi sullo stesso selettore (tiene l\'ultimo valore)', () => {
    ActionLog.push({ type: 'type', selector: '#q', text: 'Ross' });
    ActionLog.push({ type: 'type', selector: '#q', text: 'Rossi SRL' });
    expect(ActionLog.size()).toBe(1);
    expect(ActionLog.snapshot()[0].text).toBe('Rossi SRL');
  });

  it('reset azzera il log', () => {
    ActionLog.push({ type: 'click', selector: '#x' });
    ActionLog.reset();
    expect(ActionLog.size()).toBe(0);
  });


});
