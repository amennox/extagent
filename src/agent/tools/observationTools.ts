import type { Page } from "playwright-crx";
import { buildMap, _setCurrentMap } from "./pageMapTools";
import { captureScreenshot, MarkRect } from "./screenshot";
import { ToolFactory, ToolOutput } from "./types";
import { truncate, MAX_RETURN_CHARS, withActivePage, getCurrentTabId } from "./utils";

export const browserGetTitle: ToolFactory = (page: Page) =>
  ({
    name: "browser_get_title",
    description: "Return the current page title.",
    func: async () => {
      try {
        return await withActivePage(page, async (activePage) => {
          const title = await activePage.title();
          
          // Get the tab ID and send a tabTitleChanged message
          try {
            const tabId = await getCurrentTabId(activePage);
            
            // Send a message to update the UI with the tab title
            if (tabId) {
              chrome.runtime.sendMessage({
                action: 'tabTitleChanged',
                tabId: tabId,
                title: title
              });
              console.log(`Sent tabTitleChanged message for tab ${tabId} with title "${title}" from browser_get_title`);
            }
          } catch (titleError) {
            console.error("Error updating UI with tab title:", titleError);
          }
          
          return `Current page title: ${title}`;
        });
      } catch (error) {
        return `Error getting title: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserSnapshotDom: ToolFactory = (page: Page) =>
  ({
    name: "browser_snapshot_dom",
    description:
      "Capture DOM snapshot of the current page. Options (comma-separated):\n" +
      "  • selector=<css_selector> - capture only elements matching this selector\n" +
      "  • clean - remove scripts, styles, and other non-visible elements\n" +
      "  • structure - return only element tags, ids, and classes (no content)\n" +
      "  • limit=<number> - max character length (default 20000)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          // Parse options from the input string
          const options = parseSnapshotOptions(input);
          const limit = options.limit ? parseInt(options.limit, 10) : MAX_RETURN_CHARS;
          
          let html = '';
          
          // If a selector is provided, only capture matching elements
          if (options.selector) {
            // Check if the selector exists on the page
            const elementCount = await activePage.$$eval(options.selector, (els: Element[]) => els.length);
            if (elementCount === 0) {
              return `No elements found matching selector: ${options.selector}`;
            }
            
            html = await activePage.$$eval(
              options.selector, 
              (elements: Element[], opts: { structure: boolean; clean: boolean }) => {
                return elements.map(el => {
                  if (opts.structure) {
                    return getElementStructure(el);
                  } else if (opts.clean) {
                    return cleanElement(el.cloneNode(true) as Element);
                  } else {
                    return el.outerHTML;
                  }
                }).join('\n\n');
                
                // Helper function to get a clean structure representation
                function getElementStructure(element: Element): string {
                  const tagName = element.tagName.toLowerCase();
                  const id = element.id ? `#${element.id}` : '';
                  const classes = element.className && typeof element.className === 'string' 
                    ? `.${element.className.split(' ').join('.')}` 
                    : '';
                  
                  let result = `<${tagName}${id}${classes}>`;
                  
                  if (element.children.length > 0) {
                    result += '\n  ' + Array.from(element.children)
                      .map(child => getElementStructure(child))
                      .join('\n  ')
                      .replace(/\n/g, '\n  ');
                  }
                  
                  result += `\n</${tagName}>`;
                  return result;
                }
                
                // Helper function to clean an element
                function cleanElement(node: Node): string {
                  if (node.nodeType === 3) { // Text node
                    return node.textContent || '';
                  }
                  
                  if (node.nodeType !== 1) { // Not an element node
                    return '';
                  }
                  
                  const element = node as Element;
                  
                  // Skip non-visible elements
                  if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK'].includes(element.tagName)) {
                    return '';
                  }
                  
                  // Create a new clean element
                  const clean = document.createElement(element.tagName);
                  
                  // Copy attributes
                  Array.from(element.attributes).forEach((attr: Attr) => {
                    // Skip event handlers and data attributes
                    if (!attr.name.startsWith('on') && !attr.name.startsWith('data-')) {
                      clean.setAttribute(attr.name, attr.value);
                    }
                  });
                  
                  // Process children
                  Array.from(node.childNodes)
                    .map(child => cleanElement(child))
                    .filter(Boolean)
                    .forEach(childHtml => {
                      if (typeof childHtml === 'string') {
                        clean.innerHTML += childHtml;
                      }
                    });
                  
                  return clean.outerHTML;
                }
              },
              { 
                structure: options.structure || false,
                clean: options.clean || false
              }
            );
          } else {
            // Capture the entire page
            if (options.structure) {
              html = await activePage.evaluate(() => {
                function getPageStructure(element: Element, depth = 0): string {
                  const tagName = element.tagName.toLowerCase();
                  const id = element.id ? `#${element.id}` : '';
                  const classes = element.className && typeof element.className === 'string' 
                    ? `.${element.className.split(' ').join('.')}` 
                    : '';
                  
                  let result = '  '.repeat(depth) + `<${tagName}${id}${classes}>`;
                  
                  if (element.children.length > 0) {
                    result += '\n' + Array.from(element.children)
                      .map(child => getPageStructure(child, depth + 1))
                      .join('\n');
                  }
                  
                  result += '\n' + '  '.repeat(depth) + `</${tagName}>`;
                  return result;
                }
                
                return getPageStructure(document.documentElement);
              });
            } else if (options.clean) {
              html = await activePage.evaluate(() => {
                function cleanNode(node: Node): string {
                  if (node.nodeType === 3) { // Text node
                    return node.textContent || '';
                  }
                  
                  if (node.nodeType !== 1) { // Not an element node
                    return '';
                  }
                  
                  const element = node as Element;
                  
                  // Skip non-visible elements
                  if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK'].includes(element.tagName)) {
                    return '';
                  }
                  
                  // Create a new clean element
                  const clean = document.createElement(element.tagName);
                  
                  // Copy attributes
                  Array.from(element.attributes).forEach((attr: Attr) => {
                    // Skip event handlers and data attributes
                    if (!attr.name.startsWith('on') && !attr.name.startsWith('data-')) {
                      clean.setAttribute(attr.name, attr.value);
                    }
                  });
                  
                  // Process children
                  Array.from(node.childNodes)
                    .map(child => cleanNode(child))
                    .filter(Boolean)
                    .forEach(childHtml => {
                      if (typeof childHtml === 'string') {
                        clean.innerHTML += childHtml;
                      }
                    });
                  
                  return clean.outerHTML;
                }
                
                return cleanNode(document.documentElement);
              });
            } else {
              // Get the raw HTML content
              html = await activePage.content();
            }
          }
          
          return truncate(html, isNaN(limit) ? MAX_RETURN_CHARS : limit);
        });
      } catch (err) {
        return `Error capturing DOM snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

// Helper function to parse options from the input string
function parseSnapshotOptions(input: string) {
  const options: { 
    selector?: string; 
    clean?: boolean; 
    structure?: boolean; 
    limit?: string;
  } = {};
  
  if (!input || input.trim() === '') {
    return options;
  }
  
  // Check if input is just a number (backward compatibility)
  if (/^\d+$/.test(input.trim())) {
    options.limit = input.trim();
    return options;
  }
  
  // Parse comma-separated options
  input.split(',').forEach(part => {
    const trimmed = part.trim();
    
    if (trimmed === 'clean') {
      options.clean = true;
    } else if (trimmed === 'structure') {
      options.structure = true;
    } else if (trimmed.startsWith('selector=')) {
      options.selector = trimmed.substring('selector='.length);
    } else if (trimmed.startsWith('limit=')) {
      options.limit = trimmed.substring('limit='.length);
    }
  });
  
  return options;
}

export const browserQuery: ToolFactory = (page: Page) =>
  ({
    name: "browser_query",
    description:
      "Return up to 10 outerHTML snippets for a CSS selector you provide.",
    func: async (selector: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const matches = (await activePage.$$eval(
            selector,
            (nodes: Element[]) => nodes.slice(0, 10).map((n) => n.outerHTML)
          )) as string[];
          if (!matches.length) return `No nodes matched ${selector}`;
          return truncate(matches.join("\n\n"));
        });
      } catch (err) {
        return `Error querying '${selector}': ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

export const browserAccessibleTree: ToolFactory = (page: Page) =>
  ({
    name: "browser_accessible_tree",
    description:
      "Return the AX accessibility tree JSON (default: interesting‑only). Input 'all' to dump full tree. Note: This tool can be useful when the DOM is too large to process.",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const interestingOnly = input.trim().toLowerCase() !== "all";
          const tree = await activePage.accessibility.snapshot({ interestingOnly });
          return truncate(JSON.stringify(tree, null, 2));
        });
      } catch (err) {
        return `Error creating AX snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

export const browserReadText: ToolFactory = (page: Page) =>
  ({
    name: "browser_read_text",
    description:
      "Return all visible text on the page, concatenated in DOM order.",
    func: async () => {
      try {
        return await withActivePage(page, async (activePage) => {
          const text = await activePage.evaluate(() => {
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: (node) =>
                  node.parentElement &&
                  node.parentElement.offsetParent !== null &&
                  node.textContent!.trim()
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT,
              }
            );
            const out: string[] = [];
            while (walker.nextNode())
              out.push((walker.currentNode as Text).textContent!.trim());
            return out.join("\n");
          });
          return truncate(text as string);
        });
      } catch (err) {
        return `Error extracting text: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

export const browserScreenshot: ToolFactory = (page: Page) =>
  ({
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page and show it to the model (vision models) and the user. " +
      "Input flags (comma-separated): (none) viewport · full = full scrolling page · marks = draw the [numbers] of browser_observe.",
    func: async (input: string): Promise<ToolOutput> => {
      try {
        return await withActivePage(page, async (activePage) => {
          const flags = (input ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
          const fullPage = flags.includes("full");
          let marks: MarkRect[] | undefined;
          if (flags.includes("marks")) {
            const map = await buildMap(activePage);
            _setCurrentMap(map);
            marks = map.entries.filter(e => e.rect).map(e => ({ ref: e.ref, ...e.rect! }));
          }
          const image = await captureScreenshot(activePage, { fullPage, marks });
          return {
            text: `Screenshot captured (${fullPage ? "full page" : "viewport"}${marks ? ", with element numbers" : ""}).`,
            image,
          };
        });
      } catch (err) {
        return { text: `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
