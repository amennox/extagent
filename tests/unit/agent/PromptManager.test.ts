import { jest } from '@jest/globals';
import { PromptManager } from '../../../src/agent/PromptManager';
import { BrowserTool } from '../../../src/agent/tools/types';
import { TOOL_DESCRIPTIONS_IT } from '../../../src/agent/tools/descriptions.it';
import { TOOL_DESCRIPTIONS_EN } from '../../../src/agent/tools/descriptions.en';

const mockNavigatorMac = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

Object.defineProperty(global, 'navigator', {
  value: mockNavigatorMac,
  writable: true
});

describe('PromptManager', () => {
  let promptManager: PromptManager;
  let mockTools: BrowserTool[];

  beforeEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: mockNavigatorMac,
      writable: true
    });

    mockTools = [
      {
        name: 'browser_click',
        description: 'Click on an element using CSS selector',
        func: jest.fn().mockResolvedValue('Clicked successfully') as any
      },
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL',
        func: jest.fn().mockResolvedValue('Navigated successfully') as any
      },
      {
        name: 'lookup_memories',
        description: 'Look up stored memories for a domain.',
        func: jest.fn().mockResolvedValue('Memories retrieved') as any
      }
    ];

    promptManager = new PromptManager(mockTools);
  });

  describe('Constructor', () => {
    it('should initialize with provided tools', () => {
      expect(promptManager).toBeInstanceOf(PromptManager);
    });

    it('should handle empty tools array', async () => {
      const emptyPm = new PromptManager([]);
      const systemPrompt = await emptyPm.getSystemPrompt('it');
      expect(systemPrompt).toContain('DomMotion');
    });

    it('should handle null/undefined tools gracefully', () => {
      expect(() => { new PromptManager(null as any); }).not.toThrow();
      expect(() => { new PromptManager(undefined as any); }).not.toThrow();
    });
  });

  describe('setCurrentPageContext', () => {
    it('should set page context with URL and title', async () => {
      promptManager.setCurrentPageContext('https://example.com', 'Example Page');
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('CURRENT PAGE CONTEXT');
      expect(systemPrompt).toContain('https://example.com');
      expect(systemPrompt).toContain('Example Page');
    });

    it('should update page context when called multiple times', async () => {
      promptManager.setCurrentPageContext('https://first.com', 'First Page');
      let systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('https://first.com');

      promptManager.setCurrentPageContext('https://second.com', 'Second Page');
      systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('https://second.com');
      expect(systemPrompt).not.toContain('https://first.com');
    });

    it('should handle special characters in URL and title', async () => {
      const url = 'https://example.com/path?query=value&other=test';
      const title = 'Page with "quotes" & special chars';
      promptManager.setCurrentPageContext(url, title);
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain(url);
      expect(systemPrompt).toContain(title);
    });

    it('should not include page context section when not set', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).not.toContain('CURRENT PAGE CONTEXT');
    });

    it('should include page context section when set', async () => {
      promptManager.setCurrentPageContext('https://test.com', 'Test Page');
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('CURRENT PAGE CONTEXT');
      expect(systemPrompt).toContain('https://test.com');
    });
  });

  describe('getSystemPrompt', () => {
    it('restituisce il prompt italiano di default quando lang="it"', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('DomMotion');
      expect(systemPrompt).toContain('Sequenza canonica');
    });

    it('restituisce il prompt inglese di default quando lang="en"', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('en');
      expect(systemPrompt).toContain('DomMotion');
      expect(systemPrompt).toContain('Canonical Sequence');
    });

    it('restituisce il prompt personalizzato da storage quando presente', async () => {
      (chrome.storage.local.get as jest.Mock).mockResolvedValueOnce({ customSystemPrompt: 'custom system prompt text' });
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('custom system prompt text');
    });

    it('usa il default se lo storage restituisce stringa vuota', async () => {
      (chrome.storage.local.get as jest.Mock).mockResolvedValueOnce({ customSystemPrompt: '' });
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('DomMotion');
      expect(systemPrompt).not.toContain('custom system prompt text');
    });

    it('il prompt italiano contiene istruzione lookup_memories', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('lookup_memories');
    });

    it('il prompt italiano contiene istruzione browser_interactive_map', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('browser_interactive_map');
    });

    it('should include tool descriptions in the prompt', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('browser_click');
      expect(systemPrompt).toContain('browser_navigate');
    });

    it('should include canonical sequence instructions', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('lookup_memories');
      expect(systemPrompt).toContain('browser_interactive_map');
    });

    it('should include memory format section', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('Formato memoria');
      expect(systemPrompt).toContain('browser_click');
    });

    it('should include tool-call syntax instructions', async () => {
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('<tool>nome_tool</tool>');
      expect(systemPrompt).toContain('<input>argomenti</input>');
      expect(systemPrompt).toContain('<requires_approval>true o false</requires_approval>');
    });

    it('should detect macOS and use Command key', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        writable: true
      });
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('macOS');
      expect(systemPrompt).toContain('Command');
    });

    it('should detect Windows and use Control key', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        writable: true
      });
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('Windows');
      expect(systemPrompt).toContain('Control');
      Object.defineProperty(global, 'navigator', { value: mockNavigatorMac, writable: true });
    });

    it('should detect Linux and use Control key', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
        writable: true
      });
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('Linux');
      expect(systemPrompt).toContain('Control');
      Object.defineProperty(global, 'navigator', { value: mockNavigatorMac, writable: true });
    });

    it('should handle undefined navigator gracefully (no throw)', async () => {
      Object.defineProperty(global, 'navigator', { value: undefined, writable: true });
      await expect(promptManager.getSystemPrompt('it')).resolves.toContain('DomMotion');
      Object.defineProperty(global, 'navigator', { value: mockNavigatorMac, writable: true });
    });

    it('should generate consistent prompts for same inputs', async () => {
      const prompt1 = await promptManager.getSystemPrompt('it');
      const prompt2 = await promptManager.getSystemPrompt('it');
      expect(prompt1).toBe(prompt2);
    });
  });

  describe('tool descriptions', () => {
    it('ogni tool ha una descrizione < 200 caratteri (mappa IT)', () => {
      for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS_IT)) {
        expect(desc.length).toBeLessThan(200);
      }
    });

    it('ogni tool ha una descrizione < 200 caratteri (mappa EN)', () => {
      for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS_EN)) {
        expect(desc.length).toBeLessThan(200);
      }
    });

    it('tutte le chiavi IT hanno corrispondente chiave EN', () => {
      const itKeys = new Set(Object.keys(TOOL_DESCRIPTIONS_IT));
      const enKeys = new Set(Object.keys(TOOL_DESCRIPTIONS_EN));
      for (const key of itKeys) {
        expect(enKeys.has(key)).toBe(true);
      }
    });

    it('tutte le chiavi EN hanno corrispondente chiave IT', () => {
      const itKeys = new Set(Object.keys(TOOL_DESCRIPTIONS_IT));
      const enKeys = new Set(Object.keys(TOOL_DESCRIPTIONS_EN));
      for (const key of enKeys) {
        expect(itKeys.has(key)).toBe(true);
      }
    });
  });

  describe('updateTools', () => {
    it('should update tools and reflect in system prompt', async () => {
      const newTools: BrowserTool[] = [
        {
          name: 'browser_scroll',
          description: 'Scroll the page',
          func: jest.fn().mockResolvedValue('Scrolled') as any
        }
      ];
      promptManager.updateTools(newTools);
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('browser_scroll');
      expect(systemPrompt).not.toContain('browser_navigate:');
    });

    it('should handle empty tools update', async () => {
      promptManager.updateTools([]);
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('DomMotion');
    });

    it('should preserve page context after tools update', async () => {
      promptManager.setCurrentPageContext('https://example.com', 'Example');
      promptManager.updateTools([{ name: 'new_tool', description: 'A new tool', func: jest.fn() as any }]);
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('CURRENT PAGE CONTEXT');
      expect(systemPrompt).toContain('https://example.com');
      expect(systemPrompt).toContain('new_tool');
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle complete workflow with page context and tools', async () => {
      promptManager.setCurrentPageContext('https://google.com', 'Google Search');
      promptManager.updateTools([
        { name: 'search_input', description: 'Input search query', func: jest.fn() as any },
        { name: 'search_submit', description: 'Submit search form', func: jest.fn() as any }
      ]);
      const systemPrompt = await promptManager.getSystemPrompt('it');
      expect(systemPrompt).toContain('DomMotion');
      expect(systemPrompt).toContain('CURRENT PAGE CONTEXT');
      expect(systemPrompt).toContain('https://google.com');
      expect(systemPrompt).toContain('search_input');
    });

    it('should handle rapid context changes', async () => {
      const contexts = [
        ['https://site1.com', 'Site 1'],
        ['https://site2.com', 'Site 2'],
        ['https://site3.com', 'Site 3']
      ];

      for (const [url, title] of contexts) {
        promptManager.setCurrentPageContext(url, title);
        const systemPrompt = await promptManager.getSystemPrompt('it');
        expect(systemPrompt).toContain(url);
        expect(systemPrompt).toContain(title);
      }
    });
  });

  describe('Memory and Performance', () => {
    it('should generate prompts efficiently', async () => {
      const startTime = Date.now();
      for (let i = 0; i < 20; i++) {
        await promptManager.getSystemPrompt('it');
      }
      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(2000);
    });
  });
});
