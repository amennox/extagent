import {
  createReplayContext,
  resolveExpression,
  resolveExpressions,
  resolvePath,
} from '../../../../src/agent/replay/expressionResolver';

const NOW = new Date(2026, 6, 7, 14, 30); // 7 luglio 2026, 14:30

describe('expressionResolver', () => {
  describe('date', () => {
    it('{{oggi}} → data ISO', () => {
      expect(resolveExpression('oggi', createReplayContext(), NOW)).toBe('2026-07-07');
    });

    it('{{today}} equivale a {{oggi}}', () => {
      expect(resolveExpression('today', createReplayContext(), NOW)).toBe('2026-07-07');
    });

    it('{{oggi+7g}} applica offset in giorni', () => {
      expect(resolveExpression('oggi+7g', createReplayContext(), NOW)).toBe('2026-07-14');
    });

    it('{{oggi-1g}} offset negativo', () => {
      expect(resolveExpression('oggi-1g', createReplayContext(), NOW)).toBe('2026-07-06');
    });

    it('{{oggi:GG/MM/AAAA}} formato italiano', () => {
      expect(resolveExpression('oggi:GG/MM/AAAA', createReplayContext(), NOW)).toBe('07/07/2026');
    });

    it('{{today+2d:DD/MM/YYYY}} formato con offset', () => {
      expect(resolveExpression('today+2d:DD/MM/YYYY', createReplayContext(), NOW)).toBe('09/07/2026');
    });

    it("{{ora}} → orario HH:MM", () => {
      expect(resolveExpression('ora', createReplayContext(), NOW)).toBe('14:30');
    });
  });

  describe('params e variabili', () => {
    it('risolve i parametri', () => {
      const ctx = createReplayContext({ ragione_sociale: 'Rossi SRL' });
      expect(resolveExpression('ragione_sociale', ctx, NOW)).toBe('Rossi SRL');
    });

    it('risolve variabili con path', () => {
      const ctx = createReplayContext();
      ctx.variables.ordini = { items: [{ numero: 'ORD-42' }] };
      expect(resolveExpression('ordini.items[0].numero', ctx, NOW)).toBe('ORD-42');
    });

    it('serializza in JSON le variabili oggetto', () => {
      const ctx = createReplayContext();
      ctx.variables.dati = { a: 1 };
      expect(resolveExpression('dati', ctx, NOW)).toBe('{"a":1}');
    });

    it('ritorna undefined per espressioni sconosciute', () => {
      expect(resolveExpression('sconosciuta', createReplayContext(), NOW)).toBeUndefined();
    });
  });

  describe('resolveExpressions (testo completo)', () => {
    it('sostituisce più espressioni nello stesso testo', () => {
      const ctx = createReplayContext({ cliente: 'ACME' });
      const { resolved, unresolved } = resolveExpressions(
        'Ordine per {{cliente}} del {{oggi:GG/MM/AAAA}}', ctx, NOW
      );
      expect(resolved).toBe('Ordine per ACME del 07/07/2026');
      expect(unresolved).toHaveLength(0);
    });

    it('lascia intatte le espressioni non risolvibili e le segnala', () => {
      const { resolved, unresolved } = resolveExpressions('Valore: {{ignoto}}', createReplayContext(), NOW);
      expect(resolved).toBe('Valore: {{ignoto}}');
      expect(unresolved).toEqual(['ignoto']);
    });
  });

  describe('resolvePath', () => {
    it('naviga path annidati con indici', () => {
      expect(resolvePath({ a: { b: [{ c: 5 }] } }, 'a.b[0].c')).toBe(5);
    });

    it('ritorna undefined per path inesistenti', () => {
      expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
    });
  });
});
