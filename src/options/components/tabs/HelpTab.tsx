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
        'Assegna un profilo specifico a ogni funzione dell\'agente (automazione, estrazione, skill, ecc.)',
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
      { type: 'p', content: 'La memoria permette all\'agente di imparare dall\'esperienza. Ogni volta che completa con successo un\'automazione, può memorizzare il pattern — la sequenza di azioni e selettori CSS che hanno funzionato — e riutilizzarla nelle sessioni future sullo stesso dominio.' },
      { type: 'h3', content: 'Come vengono create le memorie' },
      { type: 'ul', content: [
        'L\'agente crea automaticamente una memoria dopo ogni sequenza riuscita (tramite il tool save_memory)',
        'Le memorie contengono: dominio, pattern di azioni, selettori CSS usati, contatore di utilizzi',
        'Inizialmente sono "pending" (da validare): l\'agente le ha create ma aspettano conferma umana',
      ]},
      { type: 'h3', content: 'Validazione' },
      { type: 'ul', content: [
        'Valida (✓): conferma che il pattern sia corretto → l\'agente gli darà più peso nelle sessioni future',
        'Modifica (✏): correggi il testo se il pattern non è accurato',
        'Elimina (🗑): rimuovi memorie errate o obsolete',
        'Le memorie validate vengono iniettate nel contesto dell\'agente all\'inizio di ogni sessione sullo stesso dominio',
      ]},
      { type: 'h3', content: 'Esempi di memorie utili' },
      { type: 'ul', content: [
        'Su github.com, per cercare un file nel repository usa il tasto T per aprire il file finder, poi digita il nome del file',
        'Su linkedin.com/in/*, il selettore del nome è .pv-top-card--list .text-heading-xlarge e quello del ruolo è .text-body-medium',
        'Su amazon.it, il selettore del bottone "Aggiungi al carrello" è #add-to-cart-button. Prima di cliccare verifica che non ci siano popup overlay',
      ]},
      { type: 'h3', content: 'Export / Import' },
      { type: 'ul', content: [
        'Usa Export per salvare tutte le memorie in un file JSON (utile come backup o per condividerle con altri dispositivi)',
        'Usa Import per caricare memorie da un file JSON precedentemente esportato',
      ]},
    ],
  },
  {
    id: 'skills',
    icon: 'Zap',
    title: 'Skill',
    defaultOpen: true,
    items: [
      { type: 'p', content: 'Una skill è un workflow di automazione riutilizzabile, scritto come file Markdown. L\'agente legge la skill e la esegue passo dopo passo, usando i browser tool disponibili. Le skill sono lo strumento più potente di DomMotion: permettono di definire processi complessi una sola volta e ripeterne l\'esecuzione con un semplice comando.' },
      { type: 'h3', content: 'Struttura di una skill' },
      { type: 'code', lang: 'markdown', content: `---
title: Nome della skill
description: Breve descrizione del workflow
---

## Obiettivo

Descrivi qui lo scopo generale della skill.

## Steps

1. Primo passo — naviga al sito
   - \`navigate: https://example.com\`

2. Secondo passo — estrai i dati
   - \`extract: {"type":"object","properties":{"titolo":{"type":"string"}}}\`

3. Terzo passo — descrizione libera
   - L'agente capisce il linguaggio naturale e usa i tool appropriati` },
      { type: 'h3', content: 'Comandi step' },
      { type: 'p', content: 'I comandi step in backtick vengono interpretati direttamente dall\'execution engine (indipendentemente dal LLM):' },
      { type: 'table',
        headers: ['Comando', 'Sintassi', 'Descrizione'],
        rows: [
          ['navigate',  '`navigate: <url>`',           'Naviga a un URL specifico'],
          ['extract',   '`extract: <json-schema>`',     'Estrae dati strutturati come JSON'],
          ['paginate',  '`paginate: <json-opzioni>`',   'Raccoglie dati su più pagine'],
          ['fill',      '`fill: <json-dati>`',          'Compila campi di un form'],
          ['play',      '`play: <nome-registrazione>`', 'Esegue una registrazione salvata'],
          ['export',    '`export: <formato>`',          'Esporta i dati raccolti (csv, json)'],
        ],
      },
      { type: 'h3', content: 'Come usare i browser tool' },
      { type: 'p', content: 'Nella descrizione di ogni passo puoi indicare all\'agente quali tool usare. L\'agente interpreta le istruzioni e seleziona i tool appropriati:' },
      { type: 'code', lang: 'markdown', content: `1. Trova e clicca il pulsante "Accedi"
   - Usa \`browser_query\` con selettore \`button[data-testid="login"]\` per trovarlo
   - Poi \`browser_click\` per cliccarlo

2. Digita le credenziali nel form
   - Usa \`browser_type\` con selettore \`input[name="email"]\` per l'email
   - Usa \`browser_type\` con selettore \`input[name="password"]\` per la password
   - Usa \`browser_press_key\` con tasto \`Tab\` per spostarti tra i campi

3. Attendi il caricamento della pagina post-login
   - Usa \`browser_wait_for_navigation\` con modalità \`networkidle\`` },
      { type: 'h3', content: 'Parametri e variabili' },
      { type: 'p', content: 'Puoi rendere una skill parametrica descrivendo le variabili nel testo. Quando la skill viene eseguita tramite il tool use_skill con parametri, l\'agente sostituisce le variabili nel contesto:' },
      { type: 'code', lang: 'markdown', content: `---
title: Cerca prodotto
description: Cerca {params.query} su {params.sito} e restituisce i primi risultati con prezzo
---

## Steps

1. Naviga al sito {params.sito}
   - \`navigate: {params.sito}\`

2. Cerca il termine "{params.query}"
   - Usa \`browser_type\` nel campo di ricerca (selettore: \`input[type="search"]\` o \`input[name="q"]\`)
   - Premi \`Enter\` con \`browser_press_key\`

3. Estrai i risultati
   - \`extract: {"type":"array","items":{"properties":{"nome":{"type":"string"},"prezzo":{"type":"string"}}}}\`` },
      { type: 'note', content: 'I parametri vengono passati quando invochi la skill: "Esegui la skill Cerca prodotto con query=scarpe rosse e sito=zalando.it". L\'agente interpreta i parametri dal linguaggio naturale.' },
      { type: 'h3', content: 'Logica condizionale (if/then)' },
      { type: 'p', content: 'Le skill non hanno costrutti if/else nativi, ma puoi descrivere la logica condizionale in linguaggio naturale. L\'agente la interpreta e decide autonomamente:' },
      { type: 'code', lang: 'markdown', content: `1. Verifica se l'utente è già loggato
   - Usa \`browser_query\` per cercare \`.user-avatar\` o \`.account-menu\`
   - SE l'elemento è presente → salta al passo 4 (l'utente è già loggato)
   - SE assente → prosegui con il login al passo 2

2. Clicca su "Accedi" (solo se non loggato)
   - Usa \`browser_click\` sul link o bottone "Accedi" / "Login"

3. Inserisci le credenziali e completa il login
   - Usa \`browser_type\` per email e password

4. Procedi con l'operazione principale
   ...` },
      { type: 'p', content: 'Per scenari con molte condizioni, usa una decision matrix come sezione separata nella skill:' },
      { type: 'code', lang: 'markdown', content: `## Decision matrix

| Condizione rilevata               | Azione da eseguire                            |
|-----------------------------------|-----------------------------------------------|
| Pagina di errore (404, 500)       | Segnala l'errore all'utente e termina         |
| Banner cookie/GDPR presente       | Clicca "Accetta tutto" e aspetta 1 secondo    |
| Form di login visibile            | Esegui il login prima di procedere            |
| CAPTCHA o verifica umana          | Chiedi conferma all'utente (usa approval)     |
| Risultati vuoti                   | Notifica "nessun risultato" e termina         |
| Dashboard / area loggata visibile | Procedi direttamente dal passo 4              |` },
      { type: 'h3', content: 'Esempio skill completa' },
      { type: 'code', lang: 'markdown', content: `---
title: Prezzi Amazon
description: Cerca un prodotto su Amazon.it e restituisce i primi 5 risultati con nome e prezzo
---

## Obiettivo

Automatizzare la ricerca di prezzi su Amazon per confronto rapido.
Parametri: fornisci il termine di ricerca nel prompt (es. "cerca prezzi scarpe Nike").

## Steps

1. Naviga su Amazon Italia
   - \`navigate: https://www.amazon.it\`
   - Attendi il caricamento completo

2. Gestisci eventuali popup
   - SE presente un overlay cookie: usa \`browser_click\` su \`#sp-cc-accept\` o sul bottone "Accetta"
   - SE presente un popup di benvenuto: chiudi con \`browser_press_key\` \`Escape\`

3. Inserisci il termine di ricerca
   - Usa \`browser_click\` sul campo di ricerca \`#twotabsearchtextbox\`
   - Usa \`browser_type\` per digitare il termine di ricerca fornito dall'utente
   - Usa \`browser_press_key\` con tasto \`Enter\`

4. Attendi il caricamento dei risultati
   - Usa \`browser_wait_for_navigation\` con \`networkidle\`

5. Estrai i primi 5 risultati
   - \`extract: {"type":"array","maxItems":5,"items":{"type":"object","properties":{"nome":{"type":"string","description":"Nome del prodotto"},"prezzo":{"type":"string","description":"Prezzo completo con valuta"},"rating":{"type":"string","description":"Valutazione stelle"},"url":{"type":"string","description":"Link al prodotto"}}}}\`

## Note

- Se Amazon mostra un CAPTCHA, chiedi approvazione all'utente prima di procedere
- I prezzi possono variare per utenti Prime vs non-Prime` },
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
        'Assign a specific profile to each agent function (automation, extraction, skills, etc.)',
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
      { type: 'p', content: 'Memory allows the agent to learn from experience. Each time it successfully completes an automation, it can save the pattern — the sequence of actions and CSS selectors that worked — and reuse it in future sessions on the same domain.' },
      { type: 'h3', content: 'How memories are created' },
      { type: 'ul', content: [
        'The agent automatically creates a memory after each successful sequence (via the save_memory tool)',
        'Memories contain: domain, action pattern, CSS selectors used, usage counter',
        'Initially they are "pending" (awaiting validation): the agent created them but they await human confirmation',
      ]},
      { type: 'h3', content: 'Validation' },
      { type: 'ul', content: [
        'Validate (✓): confirm that the pattern is correct → the agent will give it more weight in future sessions',
        'Edit (✏): correct the text if the pattern is inaccurate',
        'Delete (🗑): remove incorrect or outdated memories',
        'Validated memories are injected into the agent\'s context at the start of each session on the same domain',
      ]},
      { type: 'h3', content: 'Examples of useful memories' },
      { type: 'ul', content: [
        'On github.com, to find a file in the repository use the T key to open the file finder, then type the filename',
        'On linkedin.com/in/*, the name selector is .pv-top-card--list .text-heading-xlarge and the role selector is .text-body-medium',
        'On amazon.com, the "Add to Cart" button selector is #add-to-cart-button. Before clicking, check for any overlay popups',
      ]},
      { type: 'h3', content: 'Export / Import' },
      { type: 'ul', content: [
        'Use Export to save all memories to a JSON file (useful as backup or to share with other devices)',
        'Use Import to load memories from a previously exported JSON file',
      ]},
    ],
  },
  {
    id: 'skills',
    icon: 'Zap',
    title: 'Skills',
    defaultOpen: true,
    items: [
      { type: 'p', content: 'A skill is a reusable automation workflow, written as a Markdown file. The agent reads the skill and executes it step by step, using the available browser tools. Skills are DomMotion\'s most powerful feature: they let you define complex processes once and repeat them with a simple command.' },
      { type: 'h3', content: 'Skill structure' },
      { type: 'code', lang: 'markdown', content: `---
title: Skill name
description: Short description of the workflow
---

## Goal

Describe the overall purpose of the skill here.

## Steps

1. First step — navigate to the site
   - \`navigate: https://example.com\`

2. Second step — extract data
   - \`extract: {"type":"object","properties":{"title":{"type":"string"}}}\`

3. Third step — free description
   - The agent understands natural language and picks the right tools` },
      { type: 'h3', content: 'Step commands' },
      { type: 'p', content: 'Backtick step commands are interpreted directly by the execution engine (independent of the LLM):' },
      { type: 'table',
        headers: ['Command', 'Syntax', 'Description'],
        rows: [
          ['navigate',  '`navigate: <url>`',           'Navigate to a specific URL'],
          ['extract',   '`extract: <json-schema>`',     'Extract structured data as JSON'],
          ['paginate',  '`paginate: <json-options>`',   'Collect data across multiple pages'],
          ['fill',      '`fill: <json-data>`',          'Fill form fields from a data payload'],
          ['play',      '`play: <recording-name>`',     'Replay a saved recording'],
          ['export',    '`export: <format>`',           'Export collected data (csv, json)'],
        ],
      },
      { type: 'h3', content: 'Using browser tools' },
      { type: 'p', content: 'In each step description you can tell the agent which tools to use. The agent interprets the instructions and selects the appropriate tools:' },
      { type: 'code', lang: 'markdown', content: `1. Find and click the "Sign In" button
   - Use \`browser_query\` with selector \`button[data-testid="login"]\` to locate it
   - Then \`browser_click\` to click it

2. Type credentials in the form
   - Use \`browser_type\` with selector \`input[name="email"]\` for the email
   - Use \`browser_type\` with selector \`input[name="password"]\` for the password
   - Use \`browser_press_key\` with key \`Tab\` to move between fields

3. Wait for post-login page to load
   - Use \`browser_wait_for_navigation\` with mode \`networkidle\`` },
      { type: 'h3', content: 'Parameters and variables' },
      { type: 'p', content: 'You can make a skill parametric by describing variables in the text. When the skill is invoked via the use_skill tool with parameters, the agent substitutes variables from context:' },
      { type: 'code', lang: 'markdown', content: `---
title: Search product
description: Search {params.query} on {params.site} and return the top results with price
---

## Steps

1. Navigate to {params.site}
   - \`navigate: {params.site}\`

2. Search for "{params.query}"
   - Use \`browser_type\` in the search field (selector: \`input[type="search"]\` or \`input[name="q"]\`)
   - Press \`Enter\` with \`browser_press_key\`

3. Extract results
   - \`extract: {"type":"array","items":{"properties":{"name":{"type":"string"},"price":{"type":"string"}}}}\`` },
      { type: 'note', content: 'Parameters are passed when you invoke the skill: "Run the Search Product skill with query=red sneakers and site=amazon.com". The agent interprets parameters from natural language.' },
      { type: 'h3', content: 'Conditional logic (if/then)' },
      { type: 'p', content: 'Skills don\'t have native if/else constructs, but you can describe conditional logic in natural language. The agent interprets it and decides autonomously:' },
      { type: 'code', lang: 'markdown', content: `1. Check if the user is already logged in
   - Use \`browser_query\` to look for \`.user-avatar\` or \`.account-menu\`
   - IF element found → skip to step 4 (user is already logged in)
   - IF not found → continue with login at step 2

2. Click "Sign In" (only if not logged in)
   - Use \`browser_click\` on the "Sign In" / "Login" link or button

3. Enter credentials and complete login
   - Use \`browser_type\` for email and password

4. Proceed with the main operation
   ...` },
      { type: 'p', content: 'For scenarios with many conditions, use a decision matrix as a separate section in the skill:' },
      { type: 'code', lang: 'markdown', content: `## Decision matrix

| Detected condition                | Action to take                                |
|-----------------------------------|-----------------------------------------------|
| Error page (404, 500)             | Report error to user and stop                 |
| Cookie/GDPR banner visible        | Click "Accept all" and wait 1 second          |
| Login form visible                | Complete login before proceeding              |
| CAPTCHA or human check            | Ask user confirmation (use approval)          |
| Empty results                     | Notify "no results found" and stop            |
| Dashboard / logged area visible   | Proceed directly from step 4                  |` },
      { type: 'h3', content: 'Complete skill example' },
      { type: 'code', lang: 'markdown', content: `---
title: Amazon Price Search
description: Search a product on Amazon and return the top 5 results with name and price
---

## Goal

Automate price searches on Amazon for quick comparison.
Parameters: provide the search term in the prompt (e.g. "search for Nike shoe prices").

## Steps

1. Navigate to Amazon
   - \`navigate: https://www.amazon.com\`
   - Wait for complete load

2. Handle any popups
   - IF a cookie overlay is present: use \`browser_click\` on \`#sp-cc-accept\` or the "Accept" button
   - IF a welcome popup appears: close with \`browser_press_key\` \`Escape\`

3. Enter search term
   - Use \`browser_click\` on the search field \`#twotabsearchtextbox\`
   - Use \`browser_type\` to type the search term provided by the user
   - Use \`browser_press_key\` with key \`Enter\`

4. Wait for results to load
   - Use \`browser_wait_for_navigation\` with \`networkidle\`

5. Extract the top 5 results
   - \`extract: {"type":"array","maxItems":5,"items":{"type":"object","properties":{"name":{"type":"string","description":"Product name"},"price":{"type":"string","description":"Full price with currency"},"rating":{"type":"string","description":"Star rating"},"url":{"type":"string","description":"Product link"}}}}\`

## Notes

- If Amazon shows a CAPTCHA, request user approval before proceeding
- Prices may differ for Prime vs non-Prime users` },
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
