import React, { useState } from 'react';
import { useLang } from '../../../i18n';
import { LucideIcon } from '../../../ui';

// ─── Data types ────────────────────────────────────────────────────────────

interface HelpItem {
  type: 'p' | 'ul' | 'code' | 'h3' | 'note' | 'table';
  content?: string | string[];
  lang?: string;
  headers?: string[];
  rows?: string[][];
}

interface HelpSection {
  id: string;
  icon: string;
  title: string;
  defaultOpen?: boolean;
  items: HelpItem[];
}

// ─── Italian content ────────────────────────────────────────────────────────

const SECTIONS_IT: HelpSection[] = [
  {
    id: 'llm',
    icon: 'Cpu',
    title: 'Configurazione LLM',
    items: [
      { type: 'p', content: 'DomMotion si connette a qualsiasi endpoint OpenAI-compatibile: OpenAI, Azure, server locali con Ollama, LM Studio, vLLM, e molti altri. Dalla tab Configurazione LLM puoi gestire tutte le impostazioni del modello.' },
      { type: 'h3', content: 'Credenziali' },
      { type: 'ul', content: [
        'API Key: la chiave di autenticazione del tuo provider',
        'Base URL: l\'indirizzo dell\'endpoint (es. https://api.openai.com/v1 oppure http://localhost:11434/v1 per Ollama locale)',
        'Usa "Testa connessione" per verificare che le credenziali funzionino',
      ]},
      { type: 'h3', content: 'Profili modello' },
      { type: 'ul', content: [
        'Puoi creare più profili con impostazioni diverse (nome, Model ID, context window, max token, temperatura)',
        'Il profilo marcato DEFAULT viene usato per tutte le funzioni non specificamente assegnate',
        'Abilita Thinking per i modelli che supportano extended reasoning (es. Qwen3 con enable_thinking)',
      ]},
      { type: 'h3', content: 'Function Routing' },
      { type: 'ul', content: [
        'Assegna un profilo specifico a ogni funzione dell\'agente (automazione, estrazione, procedure, ecc.)',
        'Utile quando vuoi usare un modello veloce per task semplici e uno più capace per ragionamenti complessi',
        'Esempio: profilo "Fast · GPT-4o-mini" per l\'osservazione, "Reasoning · o3-mini" per la pianificazione',
      ]},
      { type: 'note', content: 'La API Key è salvata localmente nel tuo browser (chrome.storage.sync) e non viene mai trasmessa ad altri server oltre al tuo endpoint LLM.' },
    ],
  },
  {
    id: 'memory',
    icon: 'BrainCircuit',
    title: 'Memoria',
    items: [
      { type: 'p', content: 'Le memorie sono note brevi su come svolgere un compito su un dominio. All\'inizio di ogni task sullo stesso sito le migliori (validate per prime) vengono date all\'agente come suggerimento.' },
      { type: 'h3', content: 'Come nascono' },
      { type: 'ul', content: [
        'Dal pulsante "Rifletti e impara" del side panel: salva la richiesta e le azioni dell\'ultimo task (senza un secondo giro dell\'LLM)',
        'Dal feedback 👍 / 👎 dopo un task: valida o indebolisce le memorie usate',
        'Dall\'import di un file JSON',
      ]},
      { type: 'h3', content: 'Memorie e procedure' },
      { type: 'p', content: 'Una memoria è un suggerimento che l\'agente adatta. Se vuoi ripetere esattamente la stessa operazione usa una Procedura: viene eseguita passo per passo senza LLM.' },
      { type: 'h3', content: 'Gestione' },
      { type: 'ul', content: [
        'Valida (✓) le memorie corrette: hanno priorità',
        'Modifica (✏) il testo o elimina (🗑) quelle errate',
        'Export / Import JSON per backup o per condividerle',
      ]},
    ],
  },
  {
    id: 'skills',
    icon: 'Workflow',
    title: 'Procedure',
    items: [
      { type: 'p', content: 'Una procedura è una sequenza di passi (apri pagina, clicca, compila, seleziona, estrai, passo AI) con parametri tipizzati e storico delle esecuzioni. Sostituisce le vecchie "registrazioni" e "skill": quelle esistenti vengono migrate automaticamente.' },
      { type: 'h3', content: 'Come si crea' },
      { type: 'ul', content: [
        'Registrando: side panel → Registra → Avvia, esegui l\'operazione, Stop. Ogni azione diventa un passo con miniatura dell\'elemento. Funziona anche dentro iframe e web component.',
        'Da un task riuscito: dopo che l\'agente ha completato un compito compare "Salva come procedura".',
        'A mano o per import: Opzioni → Procedure → Nuova / Importa.',
      ]},
      { type: 'h3', content: 'Parametri' },
      { type: 'ul', content: [
        'Nell\'editor usa "Rendi parametro" su un valore digitato: diventa {{nome}} e verrà chiesto a ogni esecuzione (il valore registrato resta come default).',
        '"Suggerisci nome e parametri (AI)" propone automaticamente nome, descrizione e valori da parametrizzare.',
        'Password, IBAN, carte e codici fiscali non vengono mai salvati: diventano parametri obbligatori (tipo secret per le password).',
        'Espressioni disponibili: {{oggi}}, {{oggi+7g:GG/MM/AAAA}}, {{ora}}, e le variabili prodotte dai passi precedenti ({{ordini.totale}}).',
      ]},
      { type: 'h3', content: 'Tipi di passo' },
      { type: 'table',
        headers: ['Tipo', 'Valore', 'Cosa fa'],
        rows: [
          ['navigate', 'URL', 'Apre la pagina'],
          ['click', '—', 'Clicca l\'elemento'],
          ['fill', 'testo o {{param}}', 'Compila il campo'],
          ['select', 'opzione', 'Sceglie in un menu (anche personalizzato)'],
          ['check', 'true / false', 'Spunta o toglie la spunta'],
          ['press', 'tasto (Enter…)', 'Preme un tasto sull\'elemento'],
          ['wait', 'secondi', 'Attende (vuoto = finché la pagina è stabile)'],
          ['scroll', 'down / up / top / bottom', 'Scorre la pagina o porta in vista l\'elemento'],
          ['extract', 'schema JSON', 'Estrae dati strutturati in una variabile'],
          ['ai', 'istruzione', 'Passo svolto dall\'agente (decisioni, casi variabili)'],
        ],
      },
      { type: 'h3', content: 'Esecuzione' },
      { type: 'ul', content: [
        'Dal side panel: le procedure del sito corrente compaiono come pulsanti sopra la barra di input. Un clic, eventuali parametri, via.',
        'Dall\'agente: a inizio task riceve l\'elenco delle procedure del sito e può usarle con run_procedure.',
        'Dall\'editor: "Esegui", "Esegui fino a qui" e "Prova questo passo" agiscono sul tab web usato più di recente.',
        'Ogni elemento viene cercato con più strategie (selettori registrati, ruolo e nome accessibile, etichetta, testo). Se un passo fallisce, o è un passo AI, subentra l\'agente solo per quel passo e poi la procedura riprende.',
        'I passi rischiosi (eliminazioni, pagamenti, invii, conferme) chiedono conferma secondo l\'impostazione "Conferme delle azioni"; puoi forzare "chiedi sempre" o "mai" per singolo passo.',
      ]},
      { type: 'h3', content: 'Condivisione' },
      { type: 'p', content: 'Esporta in JSON (formato di scambio, con miniature) o in Markdown (documentazione leggibile).' },
    ],
  },
  {
    id: 'profiles',
    icon: 'Globe',
    title: 'Profili Dominio',
    items: [
      { type: 'p', content: 'Un Profilo Dominio personalizza il comportamento dell\'agente per un sito web specifico. Quando l\'agente lavora su un sito che corrisponde a un profilo attivo, riceve automaticamente contesto aggiuntivo che lo rende più efficace su quel dominio.' },
      { type: 'h3', content: 'Componenti di un profilo' },
      { type: 'ul', content: [
        'Pattern dominio: espressione glob che identifica i siti (es. *.github.com, linkedin.com/in/*, *.shopify.com)',
        'Addendum prompt: testo aggiunto al system prompt — istruzioni specifiche per quel sito',
        'Hint selettori CSS: aiutano l\'agente a trovare elementi specifici (formato: selettore → significato, uno per riga)',
        'Schema JSON di default: schema preimpostato per le estrazioni su quel sito',
      ]},
      { type: 'h3', content: 'Come funziona il pattern dominio' },
      { type: 'ul', content: [
        'linkedin.com/in/* → corrisponde a tutti i profili LinkedIn',
        '*.github.com → corrisponde a github.com e tutti i sottodomini',
        'amazon.* → corrisponde ad amazon.it, amazon.com, amazon.de, ecc.',
        'app.notion.so → corrisponde esattamente a quel sottodominio',
      ]},
      { type: 'h3', content: 'LinkedIn — Profili persone' },
      { type: 'ul', content: [
        'Pattern: linkedin.com/in/*',
        'Addendum: "Quando visiti un profilo LinkedIn, identifica sempre: nome completo, ruolo attuale, azienda, città. Alla fine proponi automaticamente 3 azioni: connetti, salva nel CRM, o segui il profilo."',
      ]},
      { type: 'code', content: `.pv-top-card--list .text-heading-xlarge → nome completo
.pv-top-card--list .text-body-medium → ruolo attuale
.pv-top-card--list .text-body-small → azienda e sede
.pvs-list__item--line-separated → voce esperienza` },
      { type: 'h3', content: 'GitHub — Repository' },
      { type: 'ul', content: [
        'Pattern: github.com/*/*',
        'Addendum: "Sei su un repository GitHub. Per navigare nei file usa il File Finder (tasto T). Per vedere le modifiche recenti usa la tab Commits."',
      ]},
      { type: 'code', content: `[data-hotkey="t"] → apri file finder
.repository-content → area principale contenuto
.Box-row → riga nella lista file
.commit-title → titolo commit` },
      { type: 'h3', content: 'E-commerce generico (Shopify)' },
      { type: 'ul', content: [
        'Pattern: *.shopify.com',
        'Addendum: "Stai lavorando su un sito Shopify. I prodotti sono strutturati con titolo, prezzo e varianti. Prima di aggiungere al carrello, verifica sempre la disponibilità e la variante selezionata."',
      ]},
      { type: 'code', lang: 'json', content: `{
  "type": "object",
  "properties": {
    "prodotto": { "type": "string" },
    "prezzo": { "type": "string" },
    "disponibile": { "type": "boolean" },
    "varianti": { "type": "array", "items": { "type": "string" } }
  }
}` },
    ],
  },
];

// ─── English content ────────────────────────────────────────────────────────

const SECTIONS_EN: HelpSection[] = [
  {
    id: 'llm',
    icon: 'Cpu',
    title: 'LLM Configuration',
    items: [
      { type: 'p', content: 'DomMotion connects to any OpenAI-compatible endpoint: OpenAI, Azure, local servers running Ollama, LM Studio, vLLM, and many others. From the LLM Configuration tab you can manage all model settings.' },
      { type: 'h3', content: 'Credentials' },
      { type: 'ul', content: [
        'API Key: your provider\'s authentication key',
        'Base URL: the endpoint address (e.g. https://api.openai.com/v1 or http://localhost:11434/v1 for local Ollama)',
        'Use "Test Connection" to verify that your credentials work',
      ]},
      { type: 'h3', content: 'Model Profiles' },
      { type: 'ul', content: [
        'Create multiple profiles with different settings (name, Model ID, context window, max tokens, temperature)',
        'The profile marked DEFAULT is used for all functions not specifically assigned',
        'Enable Thinking for models that support extended reasoning (e.g. Qwen3 with enable_thinking)',
      ]},
      { type: 'h3', content: 'Function Routing' },
      { type: 'ul', content: [
        'Assign a specific profile to each agent function (automation, extraction, procedures, etc.)',
        'Useful when you want a fast model for simple tasks and a more capable one for complex reasoning',
        'Example: "Fast · GPT-4o-mini" profile for observation, "Reasoning · o3-mini" for planning',
      ]},
      { type: 'note', content: 'The API Key is saved locally in your browser (chrome.storage.sync) and is never transmitted to any server other than your LLM endpoint.' },
    ],
  },
  {
    id: 'memory',
    icon: 'BrainCircuit',
    title: 'Memory',
    items: [
      { type: 'p', content: 'Memories are short notes on how to do a task on a domain. At the start of every task on the same site the best ones (validated first) are given to the agent as hints.' },
      { type: 'h3', content: 'Where they come from' },
      { type: 'ul', content: [
        'The "Reflect and learn" button in the side panel: saves the request and the actions of the last task (no second LLM pass)',
        'The 👍 / 👎 feedback after a task: validates or weakens the memories used',
        'Importing a JSON file',
      ]},
      { type: 'h3', content: 'Memories and procedures' },
      { type: 'p', content: 'A memory is a hint the agent adapts. To repeat exactly the same operation use a Procedure: it runs step by step without an LLM.' },
      { type: 'h3', content: 'Management' },
      { type: 'ul', content: [
        'Validate (✓) correct memories: they get priority',
        'Edit (✏) the text or delete (🗑) wrong ones',
        'Export / Import JSON for backup or sharing',
      ]},
    ],
  },
  {
    id: 'skills',
    icon: 'Workflow',
    title: 'Procedures',
    items: [
      { type: 'p', content: 'A procedure is a sequence of steps (open page, click, fill, select, extract, AI step) with typed parameters and a run history. It replaces the old "recordings" and "skills": existing ones are migrated automatically.' },
      { type: 'h3', content: 'How to create one' },
      { type: 'ul', content: [
        'Recording: side panel → Record → Start, perform the operation, Stop. Every action becomes a step with a thumbnail of the element. Works inside iframes and web components too.',
        'From a successful task: when the agent completes a task, "Save as procedure" appears.',
        'By hand or by import: Options → Procedures → New / Import.',
      ]},
      { type: 'h3', content: 'Parameters' },
      { type: 'ul', content: [
        'In the editor use "Make parameter" on a typed value: it becomes {{name}} and is asked at every run (the recorded value stays as default).',
        '"Suggest name and parameters (AI)" proposes name, description and values to parametrize.',
        'Passwords, IBANs, cards and tax codes are never saved: they become required parameters (secret type for passwords).',
        'Expressions: {{today}}, {{today+7d:DD/MM/YYYY}}, {{now}}, and variables produced by previous steps ({{orders.total}}).',
      ]},
      { type: 'h3', content: 'Step types' },
      { type: 'table',
        headers: ['Type', 'Value', 'What it does'],
        rows: [
          ['navigate', 'URL', 'Opens the page'],
          ['click', '—', 'Clicks the element'],
          ['fill', 'text or {{param}}', 'Fills the field'],
          ['select', 'option', 'Picks an option (custom dropdowns too)'],
          ['check', 'true / false', 'Checks or unchecks'],
          ['press', 'key (Enter…)', 'Presses a key on the element'],
          ['wait', 'seconds', 'Waits (empty = until the page is stable)'],
          ['scroll', 'down / up / top / bottom', 'Scrolls the page or brings the element into view'],
          ['extract', 'JSON schema', 'Extracts structured data into a variable'],
          ['ai', 'instruction', 'Step done by the agent (decisions, variable cases)'],
        ],
      },
      { type: 'h3', content: 'Running' },
      { type: 'ul', content: [
        'From the side panel: the procedures of the current site appear as buttons above the input bar. One click, parameters if any, done.',
        'From the agent: at the start of a task it receives the site\'s procedures and can use them with run_procedure.',
        'From the editor: "Run", "Run up to here" and "Test this step" act on the most recently used web tab.',
        'Each element is located with several strategies (recorded selectors, role and accessible name, label, text). If a step fails, or is an AI step, the agent takes over for that step only, then the procedure resumes.',
        'Risky steps (deletions, payments, sending, confirmations) ask for confirmation according to the "Action confirmations" setting; you can force "always ask" or "never" per step.',
      ]},
      { type: 'h3', content: 'Sharing' },
      { type: 'p', content: 'Export as JSON (exchange format, with thumbnails) or Markdown (readable documentation).' },
    ],
  },
  {
    id: 'profiles',
    icon: 'Globe',
    title: 'Domain Profiles',
    items: [
      { type: 'p', content: 'A Domain Profile customizes the agent\'s behavior for a specific website. When the agent works on a site matching an active profile, it automatically receives additional context that makes it more effective on that domain.' },
      { type: 'h3', content: 'Profile components' },
      { type: 'ul', content: [
        'Domain pattern: glob expression identifying sites (e.g. *.github.com, linkedin.com/in/*, *.shopify.com)',
        'Prompt addendum: text added to the system prompt — site-specific instructions',
        'CSS selector hints: help the agent find specific page elements (format: selector → meaning, one per line)',
        'Default JSON schema: preset schema for data extractions on that site',
      ]},
      { type: 'h3', content: 'How domain patterns work' },
      { type: 'ul', content: [
        'linkedin.com/in/* → matches all LinkedIn profile pages',
        '*.github.com → matches github.com and all subdomains',
        'amazon.* → matches amazon.com, amazon.it, amazon.de, etc.',
        'app.notion.so → matches exactly that subdomain',
      ]},
      { type: 'h3', content: 'LinkedIn — People profiles' },
      { type: 'ul', content: [
        'Pattern: linkedin.com/in/*',
        'Addendum: "When visiting a LinkedIn profile, always identify: full name, current role, company, city. At the end automatically suggest 3 actions: connect, save to CRM, or follow the profile."',
      ]},
      { type: 'code', content: `.pv-top-card--list .text-heading-xlarge → full name
.pv-top-card--list .text-body-medium → current role
.pv-top-card--list .text-body-small → company and location
.pvs-list__item--line-separated → experience entry` },
      { type: 'h3', content: 'GitHub — Repositories' },
      { type: 'ul', content: [
        'Pattern: github.com/*/*',
        'Addendum: "You are on a GitHub repository. To navigate files use the File Finder (T key). To see recent changes use the Commits tab."',
      ]},
      { type: 'code', content: `[data-hotkey="t"] → open file finder
.repository-content → main content area
.Box-row → file list row
.commit-title → commit title` },
      { type: 'h3', content: 'Generic e-commerce (Shopify)' },
      { type: 'ul', content: [
        'Pattern: *.shopify.com',
        'Addendum: "You are on a Shopify site. Products are structured with title, price and variants. Before adding to cart, always verify availability and selected variant (size, color)."',
      ]},
      { type: 'code', lang: 'json', content: `{
  "type": "object",
  "properties": {
    "product": { "type": "string" },
    "price": { "type": "string" },
    "available": { "type": "boolean" },
    "variants": { "type": "array", "items": { "type": "string" } }
  }
}` },
    ],
  },
];

// ─── Sub-components ─────────────────────────────────────────────────────────

function CodeBlock({ content, lang: codeLang }: { content: string; lang?: string }) {
  return (
    <div style={{ margin: '10px 0', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
      {codeLang && (
        <div style={{
          padding: '4px 12px', background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)',
          fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
          letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          {codeLang}
        </div>
      )}
      <pre style={{
        margin: 0, padding: '10px 14px',
        background: 'var(--surface)',
        color: 'var(--text)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5, lineHeight: 1.55,
        overflowX: 'auto',
        whiteSpace: 'pre',
      }}>
        <code>{content}</code>
      </pre>
    </div>
  );
}

function NoteBlock({ content }: { content: string }) {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '10px 14px', margin: '10px 0',
      background: 'var(--primary-soft)', borderLeft: '3px solid var(--primary)',
      borderRadius: 6,
    }}>
      <div style={{ flexShrink: 0, paddingTop: 1 }}>
        <LucideIcon name="Info" size={14} color="var(--primary)" />
      </div>
      <span style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)' }}>{content}</span>
    </div>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const cellStyle: React.CSSProperties = {
    padding: '6px 10px', border: '1px solid var(--border)', fontSize: 12.5,
    lineHeight: 1.5, color: 'var(--text)', verticalAlign: 'top',
  };
  return (
    <div style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 400 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ ...cellStyle, background: 'var(--surface-2)', fontWeight: 600, textAlign: 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ ...cellStyle, fontFamily: j === 0 ? 'var(--font-mono)' : undefined }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionBody({ items }: { items: HelpItem[] }) {
  return (
    <div style={{ paddingTop: 12 }}>
      {items.map((item, i) => {
        switch (item.type) {
          case 'p':
            return (
              <p key={i} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)', margin: '8px 0' }}>
                {item.content as string}
              </p>
            );
          case 'h3':
            return (
              <h3 key={i} style={{
                fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.6,
                margin: '18px 0 6px', paddingBottom: 4, borderBottom: '1px solid var(--border)',
              }}>
                {item.content as string}
              </h3>
            );
          case 'ul':
            return (
              <ul key={i} style={{ margin: '6px 0', paddingLeft: 20 }}>
                {(item.content as string[]).map((li, j) => (
                  <li key={j} style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)', marginBottom: 3 }}>
                    {li}
                  </li>
                ))}
              </ul>
            );
          case 'code':
            return <CodeBlock key={i} content={item.content as string} lang={item.lang} />;
          case 'note':
            return <NoteBlock key={i} content={item.content as string} />;
          case 'table':
            return <TableBlock key={i} headers={item.headers!} rows={item.rows!} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function Accordion({ icon, title, defaultOpen, children }: { icon: string; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="ia-card" style={{ overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '14px 16px', border: 0, background: 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
          fontFamily: 'inherit',
        }}
      >
        <div style={{
          width: 34, height: 34, borderRadius: 8, flexShrink: 0,
          background: 'var(--primary-soft)', color: 'var(--primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <LucideIcon name={icon} size={16} />
        </div>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text)', textAlign: 'left' }}>
          {title}
        </span>
        <LucideIcon name={open ? 'ChevronUp' : 'ChevronDown'} size={16} color="var(--text-muted)" />
      </button>
      {open && (
        <div className="ia-expand-in" style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function HelpTab() {
  const { lang } = useLang();
  const sections = lang === 'it' ? SECTIONS_IT : SECTIONS_EN;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 780 }}>
      {sections.map(section => (
        <Accordion key={section.id} icon={section.icon} title={section.title} defaultOpen={section.defaultOpen}>
          <SectionBody items={section.items} />
        </Accordion>
      ))}
    </div>
  );
}
