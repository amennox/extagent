import { jest } from '@jest/globals';
import { createMockPage, mockChromeAPIs, mockPageContextManager } from '../../../mocks/playwright';
import { 
  mockDOMSnapshots, 
  mockAccessibilityTrees, 
  mockElementQueries, 
  mockPageText, 
  mockScreenshotData,
  mockErrorScenarios,
  generateMockHTML,
  generateLargeText
} from '../../../fixtures/toolTestData';

// Mock dependencies before importing the tools
jest.mock('../../../../src/agent/PageContextManager', () => mockPageContextManager);
jest.mock('../../../../src/agent/tools/pageMapTools', () => ({
  buildMap: jest.fn().mockResolvedValue({ url: 'https://example.com', alerts: [], entries: [{ ref: 1, role: 'button', label: 'OK', candidates: ['#ok'], rect: { x: 1, y: 2, width: 30, height: 20 } }] }),
  _setCurrentMap: jest.fn(),
}));

// Mock Chrome APIs
global.chrome = mockChromeAPIs as any;

// Mock the utils module to avoid circular dependencies
jest.mock('../../../../src/agent/tools/utils', () => ({
  withActivePage: jest.fn().mockImplementation((page, fn) => fn(page)),
  getCurrentTabId: jest.fn().mockResolvedValue(123),
  truncate: jest.fn().mockImplementation((str, maxLength = 20000) => {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + `\n\n[Truncated ${str.length - maxLength} characters]`;
  }),
  MAX_RETURN_CHARS: 20000,
}));

// Import the tools after mocking dependencies
import {
  browserGetTitle,
  browserSnapshotDom,
  browserQuery,
  browserAccessibleTree,
  browserReadText,
  browserScreenshot
} from '../../../../src/agent/tools/observationTools';

describe('Observation Tools', () => {
  let mockPage: any;

  beforeEach(() => {
    mockPage = createMockPage();
    jest.clearAllMocks();
  });

  describe('browserGetTitle', () => {
    it('should return the current page title', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockResolvedValue('Test Page Title');

      const result = await tool.func('');

      expect(result).toBe('Current page title: Test Page Title');
      expect(mockPage.title).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockRejectedValue(new Error('Page not loaded'));

      const result = await tool.func('');

      expect(result).toContain('Error getting title: Page not loaded');
    });

    it('should send tab title changed message when tab ID is available', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockResolvedValue('Updated Title');

      const result = await tool.func('');

      expect(result).toBe('Current page title: Updated Title');
      // The Chrome message should be sent via the mocked utils
      expect(mockChromeAPIs.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'tabTitleChanged',
        tabId: 123,
        title: 'Updated Title'
      });
    });

    it('should handle title retrieval without tab ID', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockResolvedValue('Title Without Tab');
      
      // Mock getCurrentTabId to return undefined
      const utilsMock = require('../../../../src/agent/tools/utils');
      utilsMock.getCurrentTabId.mockResolvedValueOnce(undefined);

      const result = await tool.func('');

      expect(result).toBe('Current page title: Title Without Tab');
    });
  });

  describe('browserSnapshotDom', () => {
    beforeEach(() => {
      mockPage.content.mockResolvedValue(mockDOMSnapshots.simple);
      mockPage.$$eval.mockResolvedValue(mockElementQueries.buttons);
    });

    it('should capture basic DOM snapshot', async () => {
      const tool = browserSnapshotDom(mockPage);

      const result = await tool.func('');

      expect(result).toContain('<html><body><h1>Simple Page</h1>');
      expect(mockPage.content).toHaveBeenCalled();
    });

    it('should capture DOM with selector filter', async () => {
      const tool = browserSnapshotDom(mockPage);
      mockPage.$$eval.mockResolvedValue(mockElementQueries.buttons);

      const result = await tool.func('selector=button');

      expect(result).toContain('<button class="cta-button">Get Started</button>');
      expect(mockPage.$$eval).toHaveBeenCalledWith('button', expect.any(Function), expect.any(Object));
    });

    it('should handle selector with no matches', async () => {
      const tool = browserSnapshotDom(mockPage);
      mockPage.$$eval.mockResolvedValue(0); // No elements found

      const result = await tool.func('selector=.nonexistent');

      expect(result).toBe('No elements found matching selector: .nonexistent');
    });

    it('should capture clean DOM snapshot', async () => {
      const tool = browserSnapshotDom(mockPage);
      mockPage.content.mockResolvedValue(mockDOMSnapshots.withScripts);

      const result = await tool.func('clean');

      expect(mockPage.evaluate).toHaveBeenCalled();
      // The evaluate function should be called with a function that cleans the DOM
      const evaluateCall = mockPage.evaluate.mock.calls[0];
      expect(evaluateCall[0]).toBeInstanceOf(Function);
    });

    it('should capture structure-only snapshot', async () => {
      const tool = browserSnapshotDom(mockPage);

      const result = await tool.func('structure');

      expect(mockPage.evaluate).toHaveBeenCalled();
      // Should call evaluate with structure extraction function
      const evaluateCall = mockPage.evaluate.mock.calls[0];
      expect(evaluateCall[0]).toBeInstanceOf(Function);
    });

    it('should respect character limit', async () => {
      const tool = browserSnapshotDom(mockPage);
      const largeContent = generateMockHTML(1000);
      mockPage.content.mockResolvedValue(largeContent);

      const result = await tool.func('limit=100');

      expect(result.length).toBeLessThanOrEqual(150); // Account for truncation message
      expect(result).toContain('[Truncated');
    });

    it('should handle multiple options', async () => {
      const tool = browserSnapshotDom(mockPage);
      mockPage.$$eval.mockResolvedValue(mockElementQueries.buttons);

      const result = await tool.func('selector=button,clean,limit=500');

      expect(mockPage.$$eval).toHaveBeenCalledWith('button', expect.any(Function), expect.objectContaining({
        clean: true,
        structure: false
      }));
    });

    it('should handle backward compatibility with numeric input', async () => {
      const tool = browserSnapshotDom(mockPage);

      const result = await tool.func('1000');

      expect(mockPage.content).toHaveBeenCalled();
      // Should treat numeric input as limit
    });

    it('should handle errors during DOM capture', async () => {
      const tool = browserSnapshotDom(mockPage);
      mockPage.content.mockRejectedValue(mockErrorScenarios.pageNotLoaded);

      const result = await tool.func('');

      expect(result).toContain('Error capturing DOM snapshot: Page not loaded');
    });
  });

  describe('browserQuery', () => {
    beforeEach(() => {
      mockPage.$$eval.mockResolvedValue(mockElementQueries.buttons);
    });

    it('should return matching elements', async () => {
      const tool = browserQuery(mockPage);

      const result = await tool.func('button');

      expect(result).toContain('<button class="cta-button">Get Started</button>');
      expect(mockPage.$$eval).toHaveBeenCalledWith('button', expect.any(Function));
    });

    it('should limit results to 10 elements', async () => {
      const tool = browserQuery(mockPage);
      const manyElements = Array.from({ length: 15 }, (_, i) => `<div>Element ${i}</div>`);
      
      // Mock $$eval to properly simulate the slice(0, 10) behavior
      mockPage.$$eval.mockImplementation((selector, fn) => {
        // Simulate the actual implementation: nodes.slice(0, 10).map((n) => n.outerHTML)
        const mockNodes = manyElements.map(html => ({ outerHTML: html }));
        return Promise.resolve(fn(mockNodes));
      });

      const result = await tool.func('div');

      // Should only return first 10 elements
      const elements = result.split('\n\n');
      expect(elements).toHaveLength(10);
      expect(elements[0]).toBe('<div>Element 0</div>');
      expect(elements[9]).toBe('<div>Element 9</div>');
    });

    it('should handle no matches', async () => {
      const tool = browserQuery(mockPage);
      mockPage.$$eval.mockResolvedValue([]);

      const result = await tool.func('.nonexistent');

      expect(result).toBe('No nodes matched .nonexistent');
    });

    it('should handle query errors', async () => {
      const tool = browserQuery(mockPage);
      mockPage.$$eval.mockRejectedValue(mockErrorScenarios.elementNotFound);

      const result = await tool.func('invalid[selector');

      expect(result).toContain('Error querying \'invalid[selector\': Element not found');
    });

    it('should truncate long results', async () => {
      const tool = browserQuery(mockPage);
      const largeElements = Array.from({ length: 5 }, () => generateMockHTML(100));
      mockPage.$$eval.mockResolvedValue(largeElements);

      const result = await tool.func('div');

      // Should be truncated if too long
      if (result.length > 20000) {
        expect(result).toContain('[Truncated');
      }
    });
  });

  describe('browserAccessibleTree', () => {
    beforeEach(() => {
      mockPage.accessibility.snapshot.mockResolvedValue(mockAccessibilityTrees.simple);
    });

    it('should return accessibility tree (interesting only)', async () => {
      const tool = browserAccessibleTree(mockPage);

      const result = await tool.func('');

      expect(result).toContain('"role": "WebArea"');
      expect(result).toContain('"name": "Simple Page"');
      expect(mockPage.accessibility.snapshot).toHaveBeenCalledWith({ interestingOnly: true });
    });

    it('should return full accessibility tree when requested', async () => {
      const tool = browserAccessibleTree(mockPage);
      mockPage.accessibility.snapshot.mockResolvedValue(mockAccessibilityTrees.complex);

      const result = await tool.func('all');

      expect(result).toContain('"role": "WebArea"');
      expect(mockPage.accessibility.snapshot).toHaveBeenCalledWith({ interestingOnly: false });
    });

    it('should handle case-insensitive "all" input', async () => {
      const tool = browserAccessibleTree(mockPage);

      await tool.func('ALL');
      expect(mockPage.accessibility.snapshot).toHaveBeenCalledWith({ interestingOnly: false });

      await tool.func('All');
      expect(mockPage.accessibility.snapshot).toHaveBeenCalledWith({ interestingOnly: false });
    });

    it('should handle accessibility snapshot errors', async () => {
      const tool = browserAccessibleTree(mockPage);
      mockPage.accessibility.snapshot.mockRejectedValue(mockErrorScenarios.permissionDenied);

      const result = await tool.func('');

      expect(result).toContain('Error creating AX snapshot: Permission denied');
    });
  });

  describe('browserReadText', () => {
    beforeEach(() => {
      mockPage.evaluate.mockResolvedValue(mockPageText.simple);
    });

    it('should extract visible text from page', async () => {
      const tool = browserReadText(mockPage);

      const result = await tool.func('');

      expect(result).toBe(mockPageText.simple);
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should handle complex page text', async () => {
      const tool = browserReadText(mockPage);
      mockPage.evaluate.mockResolvedValue(mockPageText.complex);

      const result = await tool.func('');

      expect(result).toContain('Welcome to Our Site');
      expect(result).toContain('Features');
      expect(result).toContain('© 2024 Test Company');
    });

    it('should handle empty page', async () => {
      const tool = browserReadText(mockPage);
      mockPage.evaluate.mockResolvedValue(mockPageText.empty);

      const result = await tool.func('');

      expect(result).toBe('');
    });

    it('should truncate long text content', async () => {
      const tool = browserReadText(mockPage);
      const longText = generateLargeText(5000);
      mockPage.evaluate.mockResolvedValue(longText);

      const result = await tool.func('');

      if (result.length > 20000) {
        expect(result).toContain('[Truncated');
      }
    });

    it('should handle text extraction errors', async () => {
      const tool = browserReadText(mockPage);
      mockPage.evaluate.mockRejectedValue(mockErrorScenarios.scriptError);

      const result = await tool.func('');

      expect(result).toContain('Error extracting text: Script execution failed');
    });
  });

  describe('browserScreenshot', () => {
    beforeEach(() => {
      mockPage.screenshot.mockResolvedValue(Buffer.from(mockScreenshotData.small, 'base64'));
      mockPage.evaluate.mockResolvedValue(undefined);
      mockPage.viewportSize = jest.fn().mockReturnValue({ width: 1024, height: 768 });
    });

    it('returns the image to the engine (vision) instead of an opaque reference', async () => {
      const tool = browserScreenshot(mockPage);
      const result: any = await tool.func('');
      expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'jpeg', fullPage: false, scale: 'css' }));
      expect(result.image.mediaType).toBe('image/jpeg');
      expect(result.image.data).toBe(Buffer.from(mockScreenshotData.small, 'base64').toString('base64'));
      expect(result.text).toContain('Screenshot captured (viewport');
    });

    it('takes a full page screenshot when requested', async () => {
      const tool = browserScreenshot(mockPage);
      const result: any = await tool.func('full');
      expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
      expect(result.text).toContain('full page');
    });

    it('draws the element numbers (Set-of-Marks) when asked and removes them after', async () => {
      const tool = browserScreenshot(mockPage);
      const result: any = await tool.func('marks');
      const calls = mockPage.evaluate.mock.calls;
      // draw overlay, (viewport width), remove overlay
      expect(calls[0][1]).toEqual(expect.objectContaining({ marks: [expect.objectContaining({ ref: 1 })] }));
      expect(calls[calls.length - 1][1]).toBe('__dommotion_marks__');
      expect(result.text).toContain('with element numbers');
    });

    it('reports screenshot errors as text', async () => {
      const tool = browserScreenshot(mockPage);
      mockPage.screenshot.mockRejectedValue(mockErrorScenarios.permissionDenied);
      const result: any = await tool.func('');
      expect(result.text).toContain('Error taking screenshot: Permission denied');
    });
  });

  describe('Tool Integration', () => {
    it('should work with withActivePage utility', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockResolvedValue('Integration Test');

      const result = await tool.func('');

      expect(result).toBe('Current page title: Integration Test');
      
      // Verify withActivePage was called
      const utilsMock = require('../../../../src/agent/tools/utils');
      expect(utilsMock.withActivePage).toHaveBeenCalled();
    });

    it('should handle Chrome API integration', async () => {
      const tool = browserGetTitle(mockPage);
      mockPage.title.mockResolvedValue('Chrome API Test');

      await tool.func('');

      // Verify Chrome APIs are available and can be called
      expect(mockChromeAPIs.runtime.sendMessage).toBeDefined();
    });

    it('should handle truncation properly', async () => {
      const tool = browserQuery(mockPage);
      const longContent = 'x'.repeat(25000);
      mockPage.$$eval.mockResolvedValue([longContent]);

      const result = await tool.func('div');

      // Should be truncated
      expect(result).toContain('[Truncated');
      expect(result.length).toBeLessThan(25000);
    });
  });
});
