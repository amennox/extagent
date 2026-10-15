import * as fs from 'fs';
import * as path from 'path';
import { sync as globSync } from 'glob';

const ROOT = path.resolve(__dirname, '../../');

describe('Rebranding DomMotion', () => {
  it('manifest.json non contiene "BrowserBee" o "browserbee"', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf-8');
    expect(manifest).not.toMatch(/BrowserBee/i);
    expect(manifest).not.toMatch(/browserbee/);
  });

  it('manifest.json ha name="DomMotion"', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf-8'));
    expect(manifest.name).toBe('DomMotion');
  });

  it('manifest.json ha shortcut Alt+Shift+E per _execute_side_panel', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf-8'));
    const cmd = manifest.commands?.['_execute_side_panel'];
    expect(cmd).toBeDefined();
    expect(cmd.suggested_key?.default).toBe('Alt+Shift+E');
  });

  it('package.json ha name="dom-motion"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('dom-motion');
  });

  it('nessun file src/ contiene la stringa "BrowserBee" (eccetto commenti crediti)', () => {
    const files = globSync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true });
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/BrowserBee/i.test(line) && !/credit|based on|fork of|original|originally/i.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
