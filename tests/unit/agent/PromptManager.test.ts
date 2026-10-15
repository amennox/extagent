import { PromptManager } from '../../../src/agent/PromptManager';
import { allToolSpecs } from '../../../src/agent/toolCatalog';

const core = allToolSpecs().filter(t => t.tier === 'core');

describe('PromptManager', () => {
  beforeEach(() => {
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({ customSystemPrompt: '' });
  });

  it('builds a static Italian prompt for native tool calling (no tool list, no XML format)', async () => {
    const pm = new PromptManager([]);
    pm.setCurrentPageContext('https://erp.example.com/home', 'ERP');
    const prompt = await pm.getSystemPrompt({ lang: 'it', protocol: 'native', vision: false, tools: core });
    expect(prompt).toContain('Sei **DomMotion**');
    expect(prompt).toContain('browser_observe');
    expect(prompt).not.toContain('<tool>nome_tool</tool>');
    expect(prompt).toContain('Il compito parte da https://erp.example.com/home');
    expect(prompt).toContain('Oggi è');
  });

  it('documents the XML protocol and every exposed tool in fallback mode', async () => {
    const pm = new PromptManager([]);
    const prompt = await pm.getSystemPrompt({ lang: 'en', protocol: 'xml', vision: false, tools: core });
    expect(prompt).toContain('<tool>tool_name</tool>');
    for (const t of core) expect(prompt).toContain(`- ${t.name}:`);
    expect(prompt).toContain('input JSON: {ref, text, submit}');
  });

  it('mentions the annotated screenshot only for vision models', async () => {
    const pm = new PromptManager([]);
    const v = await pm.getSystemPrompt({ lang: 'en', protocol: 'native', vision: true, tools: core });
    const nv = await pm.getSystemPrompt({ lang: 'en', protocol: 'native', vision: false, tools: core });
    expect(v).toContain('screenshot with the same numbers');
    expect(nv).not.toContain('screenshot with the same numbers');
  });

  it('is identical across calls in the same task (prefix caching)', async () => {
    const pm = new PromptManager([]);
    pm.setPagePlaybook('React SPA: wait for stability');
    pm.setProfileAddendum('Use the left menu');
    const a = await pm.getSystemPrompt({ lang: 'it', protocol: 'native', vision: false, tools: core });
    const b = await pm.getSystemPrompt({ lang: 'it', protocol: 'native', vision: false, tools: core });
    expect(a).toBe(b);
    expect(a).toContain('React SPA: wait for stability');
    expect(a).toContain('Use the left menu');
  });

  it('keeps a custom system prompt but still appends the protocol', async () => {
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({ customSystemPrompt: 'CUSTOM PROMPT' });
    const pm = new PromptManager([]);
    const prompt = await pm.getSystemPrompt({ lang: 'it', protocol: 'xml', vision: false, tools: core });
    expect(prompt.startsWith('CUSTOM PROMPT')).toBe(true);
    expect(prompt).toContain('<tool>nome_tool</tool>');
  });
});
