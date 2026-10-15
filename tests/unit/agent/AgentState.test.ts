import {
  resultKey,
  buildStateMessage, classifyResult, hasMalformedXmlCall, LoopDetector, parseXmlToolCalls, renderMessages, stripXmlCalls, Transcript,
} from '../../../src/agent/AgentState';

const obs = (n: number) => `Page ${n}\nInteractive elements (act with the [number]):\n[1] button "B${n}"`;

describe('AgentState', () => {
  it('classifies results: page observations, actions that navigated, data', () => {
    expect(classifyResult('browser_observe', obs(1))).toMatchObject({ kind: 'observation', family: 'page' });
    expect(classifyResult('browser_click_ref', 'Clicked\nNavigated to a new page.\n' + obs(2))).toMatchObject({ kind: 'observation', family: 'page', mutating: true });
    expect(classifyResult('browser_click_ref', 'Clicked · stable\nChanges:\nno visible changes')).toMatchObject({ kind: 'action', mutating: true });
    expect(classifyResult('extract_with_schema', '{}')).toMatchObject({ kind: 'data' });
  });

  it('renders native turns with tool messages and compacts superseded/old results', () => {
    const t = new Transcript();
    const turn = (name: string, text: string, i: number) => {
      const cls = classifyResult(name, text);
      t.addTurn({ text: '', protocol: 'native', calls: [{ id: `c${i}`, name, args: {}, input: '' }], results: [{ callId: `c${i}`, name, text, isError: false, ...cls }] });
    };
    turn('browser_observe', obs(1), 1);
    for (let i = 2; i <= 7; i++) turn('browser_fill_ref', `Filled [${i}] "X"\nChanges:\n~ [${i}] textbox "X" = "v"`, i);
    turn('browser_observe', obs(8), 8);
    const msgs = renderMessages(t, { history: [], task: 'TASK', state: 'STATE', lang: 'it' });
    const tool = msgs.filter(m => m.role === 'tool').map(m => m.content as string);
    expect(msgs[0]).toEqual({ role: 'user', content: 'TASK' });
    expect(tool[0]).toBe('[Superseded by a newer observation] Page 1');
    expect(tool[1]).toBe('Filled [2] "X"'); // old action shrunk to its first line
    expect(tool[6]).toContain('Changes:'); // recent action kept in full
    expect(tool[7]).toBe(obs(8));
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'STATE' });
  });

  it('attaches the latest screenshot only while it is current', () => {
    const t = new Transcript();
    const img = { data: 'AAA', mediaType: 'image/jpeg' };
    t.addTurn({ text: '', protocol: 'native', calls: [{ id: 'a', name: 'browser_observe', args: {}, input: '' }], results: [{ callId: 'a', name: 'browser_observe', text: obs(1), image: img, kind: 'observation', family: 'page', mutating: false, isError: false }] });
    expect(t.currentImage()).toEqual({ image: img, stale: false });
    const msgs = renderMessages(t, { history: [], task: 'T', state: 'S', image: t.currentImage()!.image, lang: 'en' });
    expect((msgs[msgs.length - 1].content as any[])[1].image_url.url).toBe('data:image/jpeg;base64,AAA');
    t.addTurn({ text: '', protocol: 'native', calls: [{ id: 'b', name: 'browser_click_ref', args: {}, input: '' }], results: [{ callId: 'b', name: 'browser_click_ref', text: 'Clicked', kind: 'action', mutating: true, isError: false }] });
    expect(t.currentImage()).toEqual({ stale: true });
  });

  it('merges XML results with the state in one user message', () => {
    const t = new Transcript();
    t.addTurn({ text: '<tool>browser_observe</tool><input></input>', protocol: 'xml', calls: [{ id: 'x', name: 'browser_observe', args: {}, input: '' }], results: [{ callId: 'x', name: 'browser_observe', text: obs(1), kind: 'observation', family: 'page', mutating: false, isError: false }] });
    const msgs = renderMessages(t, { history: [], task: 'T', state: 'STATE', lang: 'en' });
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toContain('Result of browser_observe:');
    expect(msgs[2].content).toContain('STATE');
  });

  it('parses XML calls (several, optional approval tag, wrong closing tag) and detects malformed ones', () => {
    const calls = parseXmlToolCalls('Ok\n<tool>browser_fill_ref</tool>\n<input>{"ref": 1, "text": "a"}</input>\n<tool>browser_click_ref</input>\n<input>2</input>\n<requires_approval>true</requires_approval>');
    expect(calls).toEqual([
      { name: 'browser_fill_ref', input: '{"ref": 1, "text": "a"}', requiresApproval: undefined },
      { name: 'browser_click_ref', input: '2', requiresApproval: true },
    ]);
    expect(stripXmlCalls('Ok\n<tool>x</tool>')).toBe('Ok');
    expect(hasMalformedXmlCall('<tool>browser observe')).toBe(true);
    expect(hasMalformedXmlCall('done')).toBe(false);
  });

  it('detects loops: warns, then stops', () => {
    const d = new LoopDetector();
    const rec = () => d.record({ signature: 'click:1', name: 'browser_click_ref', isError: false, noChange: true, mutating: true, observation: false });
    rec(); rec();
    expect(d.status('en')).toEqual({});
    rec();
    expect(d.status('en').warning).toContain('repeated browser_click_ref');
    rec(); rec();
    expect(d.status('en').stop).toContain('I stopped');
  });

  it('warns on actions with no visible effect and on error streaks', () => {
    const d = new LoopDetector();
    ['a', 'b', 'c'].forEach(s => d.record({ signature: s, name: 'browser_click_ref', isError: false, noChange: true, mutating: true, observation: false }));
    expect(d.status('it').warning).toContain('non hanno cambiato nulla');
    const e = new LoopDetector();
    ['a', 'b', 'c', 'd'].forEach(s => e.record({ signature: s, name: 't', isError: true, noChange: false, mutating: false, observation: false }));
    expect(e.status('it').warning).toContain('sono fallite');
  });

  it('builds the state message with tab, plan, dialog and warnings', () => {
    const s = buildStateMessage({
      step: 58, maxSteps: 60, url: 'https://a.it', title: 'A', tabs: 3, lang: 'en', vision: true, image: 'stale',
      plan: [{ title: 'Open', status: 'done' }, { title: 'Fill', status: 'doing' }, { title: 'Save', status: 'todo' }],
      dialog: { type: 'confirm', message: 'Sure?' }, warning: 'careful',
    });
    expect(s).toContain('[STATE — step 58 of 60]');
    expect(s).toContain('Active tab: "A" — https://a.it (3 tabs open)');
    expect(s).toContain('✓ 1. Open');
    expect(s).toContain('→ 2. Fill');
    expect(s).toContain('· 3. Save');
    expect(s).toContain('Browser dialog open (confirm): "Sure?"');
    expect(s).toContain('⚠ careful');
    expect(s).toContain('No up-to-date screenshot');
    expect(s).toContain('Only 2 steps left');
  });

  it('never renders an empty assistant message for an empty native turn', () => {
    const t = new Transcript();
    t.addTurn({ text: '', protocol: 'native', calls: [], results: [], feedback: 'FEEDBACK' });
    t.addTurn({ text: 'ok', protocol: 'native', calls: [], results: [] });
    const msgs = renderMessages(t, { history: [], task: 'T', state: 'S', lang: 'en' });
    expect(msgs.every(m => m.role !== 'assistant' || m.content || m.tool_calls?.length)).toBe(true);
    expect(msgs.map(m => m.content)).toEqual(['T', 'FEEDBACK', 'ok', 'S']);
  });

  it('does not count repeated calls as a loop when the result keeps changing', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 8; i++) {
      d.record({ signature: 'scroll:down', resultKey: resultKey(`Scrolled down\n[${i}] link "Ordine ${i}"`), name: 'browser_scroll', isError: false, noChange: false, mutating: true, observation: true });
    }
    expect(d.status('en')).toEqual({});
    expect(resultKey('Clicked · stable after 120ms')).toBe(resultKey('Clicked · stable after 480ms'));
  });
});
