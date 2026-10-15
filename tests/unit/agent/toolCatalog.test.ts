import { allToolSpecs, callSignature, exposedToolSpecs, getToolSpec, normalizeCall } from '../../../src/agent/toolCatalog';

describe('toolCatalog', () => {
  const registered = new Set(allToolSpecs().map(s => s.name));

  it('exposes a focused core set, adding vision and advanced tools only on demand', () => {
    const core = exposedToolSpecs(registered, { vision: false, advanced: false }).map(s => s.name);
    expect(core.length).toBeLessThanOrEqual(18);
    expect(core).toEqual(expect.arrayContaining(['browser_observe', 'browser_click_ref', 'browser_fill_ref', 'browser_scroll', 'run_procedure', 'update_plan']));
    expect(core).not.toContain('browser_screenshot');
    expect(core).not.toContain('browser_snapshot_dom');
    const vision = exposedToolSpecs(registered, { vision: true, advanced: false }).map(s => s.name);
    expect(vision).toEqual(expect.arrayContaining(['browser_screenshot', 'browser_click_xy']));
    const adv = exposedToolSpecs(registered, { vision: false, advanced: true }).map(s => s.name);
    expect(adv).toEqual(expect.arrayContaining(['browser_snapshot_dom', 'browser_click', 'lookup_memories']));
  });

  it('only offers tools that are actually registered (update_plan is engine-handled)', () => {
    const names = exposedToolSpecs(new Set(['browser_observe']), { vision: false, advanced: false }).map(s => s.name);
    expect(names.sort()).toEqual(['browser_observe', 'update_plan']);
  });

  it('every spec has a JSON object schema and bilingual descriptions', () => {
    for (const s of allToolSpecs()) {
      expect((s.schema as any).type).toBe('object');
      expect(s.description.it.length).toBeGreaterThan(3);
      expect(s.description.en.length).toBeGreaterThan(3);
    }
  });

  it('maps native JSON args to the legacy string input of each tool', () => {
    expect(normalizeCall('browser_click_ref', '{"ref": 12}')).toEqual({ args: { ref: 12 }, input: '12' });
    expect(normalizeCall('browser_navigate', { url: 'https://a.it' }).input).toBe('https://a.it');
    expect(normalizeCall('browser_fill_ref', { ref: 3, text: 'x' }).input).toBe('{"ref":3,"text":"x"}');
    expect(normalizeCall('browser_handle_dialog', { action: 'accept', text: 'ok' }).input).toBe('accept|ok');
    expect(normalizeCall('browser_screenshot', { full: true, marks: true }).input).toBe('full,marks');
    // Advanced tools keep the {input} wrapper
    expect(normalizeCall('browser_click', { input: '#save' }).input).toBe('#save');
  });

  it('accepts free text from the XML protocol', () => {
    expect(normalizeCall('browser_click_ref', '7')).toEqual({ args: { input: '7' }, input: '7' });
    expect(normalizeCall('browser_tab', 'list').input).toBe('{"action":"list"}');
    expect(normalizeCall('unknown_tool', '{"a":1}')).toEqual({ args: { a: 1 }, input: '{"a":1}' });
  });

  it('builds order-independent call signatures for loop detection', () => {
    expect(callSignature('t', { b: 1, a: { d: 2, c: 3 } })).toBe(callSignature('t', { a: { c: 3, d: 2 }, b: 1 }));
    expect(callSignature('t', { a: 1 })).not.toBe(callSignature('t', { a: 2 }));
    expect(getToolSpec('browser_scroll')?.family).toBe('page');
  });
});
