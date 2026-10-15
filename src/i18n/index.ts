import { useState, useEffect } from 'react';
import { en } from './en';
import { it } from './it';

export type Lang = 'it' | 'en';

const DICTS: Record<Lang, Record<string, string>> = { it, en };

export function t(key: string, lang: Lang = 'it', vars?: Record<string, string>): string {
  const dict = DICTS[lang] ?? DICTS.it;
  let str = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return str;
}

export async function getLang(): Promise<Lang> {
  try {
    const result = await chrome.storage.local.get('language');
    const lang = result.language;
    if (lang === 'it' || lang === 'en') return lang;
    return 'it';
  } catch {
    return 'it';
  }
}

export async function saveLang(lang: Lang): Promise<void> {
  try {
    await chrome.storage.local.set({ language: lang });
  } catch {
    // ignore in non-extension contexts
  }
}

export function useLang(): { lang: Lang; t: (key: string, vars?: Record<string, string>) => string } {
  const [lang, setLang] = useState<Lang>('it');

  useEffect(() => {
    getLang().then(setLang).catch(() => {});

    try {
      const handler = (
        changes: Record<string, chrome.storage.StorageChange>,
        area: string
      ) => {
        if (area === 'local' && 'language' in changes) {
          const newLang = changes.language.newValue;
          if (newLang === 'it' || newLang === 'en') setLang(newLang);
        }
      };
      chrome.storage.onChanged.addListener(handler);
      return () => chrome.storage.onChanged.removeListener(handler);
    } catch {
      return undefined;
    }
  }, []);

  return { lang, t: (key: string, vars?: Record<string, string>) => t(key, lang, vars) };
}
