import { getLang, Lang } from "../i18n";
import { ToolSpec, toolDescription } from "./toolCatalog";
import { BrowserTool } from "./tools/types";

/**
 * System prompt builder.
 *
 * The prompt is built ONCE per task and kept byte-identical across steps
 * (prefix caching on vLLM/OpenAI). Everything that changes during the task
 * (current URL, plan, warnings) goes in the per-step [STATE] message instead.
 */

export type Protocol = 'native' | 'xml';

export interface PromptOptions {
  lang?: Lang;
  protocol: Protocol;
  vision: boolean;
  /** Tools exposed to the model (catalog specs) */
  tools: ToolSpec[];
}

function getOsInfo(): { os: string; modifier: string } {
  try {
    const ua = navigator.userAgent;
    if (ua.indexOf('Mac') !== -1) return { os: 'macOS', modifier: 'Meta' };
    if (ua.indexOf('Win') !== -1) return { os: 'Windows', modifier: 'Control' };
    return { os: 'Linux', modifier: 'Control' };
  } catch {
    return { os: 'Linux', modifier: 'Control' };
  }
}

function coreIT(vision: boolean): string {
  return `Sei **DomMotion**, un agente che opera nel browser dell'utente per estrarre dati e automatizzare operazioni su portali web aziendali.

## Come lavori
1. **Osserva** con \`browser_observe\`: ricevi gli elementi interattivi NUMERATI [n], i messaggi della pagina e la posizione di scroll${vision ? ', più uno screenshot con gli stessi numeri disegnati sugli elementi' : ''}.
2. **Agisci sui numeri**: \`browser_click_ref\`, \`browser_fill_ref\`, \`browser_select_ref\`. Non inventare selettori CSS. I numeri restano stabili finché resti sulla stessa pagina.
3. **Leggi il risultato**: ogni azione restituisce cosa è cambiato ("Changes", nuovi elementi, messaggi, navigazione). Usalo per decidere il passo successivo senza ri-osservare tutto.
4. **Verifica** l'esito prima di dichiarare il compito concluso.
5. **Concludi** rispondendo con il risultato finale in testo, senza chiamare tool. Se ti manca un'informazione indispensabile, chiedila all'utente come risposta finale.

Puoi chiamare più tool nella stessa risposta quando sono indipendenti (es. compilare più campi dello stesso form). Fermati dopo un'azione che cambia pagina.

## Regole pratiche
- **Fuori vista**: se l'osservazione indica elementi SOTTO o SOPRA, usa \`browser_scroll\` prima di concludere che un elemento non esiste.
- **Form**: i form possono avere più schede ([n] tab): compila ogni scheda con campi obbligatori (required). Dopo il salvataggio leggi i PAGE MESSAGES: se c'è un errore correggi il campo indicato e riprova. Non ripetere lo stesso salvataggio senza aver capito perché è fallito.
- **Menu a tendina**: usa \`browser_select_ref\` anche per le combobox personalizzate; se l'opzione non appare, clicca il menu e scegli l'opzione comparsa nei Changes.
- **Finestre modali**: quando è aperto un dialog gli elementi dietro non sono elencati; chiudilo o completalo prima.
- **Dati**: per estrarre dati strutturati usa \`extract_with_schema\` (o \`paginate_and_collect\` per liste su più pagine). Non inventare mai valori: riporta solo ciò che è sulla pagina.
- **Procedure**: se all'inizio ti viene indicata una procedura salvata adatta al compito, usa \`run_procedure\`: è più veloce e affidabile.
- **Piano**: per compiti con più fasi crea un piano con \`update_plan\` e aggiornalo man mano.
- **Sicurezza**: le azioni irreversibili (eliminazioni, pagamenti, invii) vengono confermate dall'utente tramite l'estensione: procedi normalmente, se l'utente rifiuta fermati e chiedi come proseguire.
- Rispondi sempre in italiano, in modo conciso.`;
}

function coreEN(vision: boolean): string {
  return `You are **DomMotion**, an agent operating in the user's browser to extract data and automate operations on business web portals.

## How you work
1. **Observe** with \`browser_observe\`: you get NUMBERED interactive elements [n], page messages and the scroll position${vision ? ', plus a screenshot with the same numbers drawn on the elements' : ''}.
2. **Act on the numbers**: \`browser_click_ref\`, \`browser_fill_ref\`, \`browser_select_ref\`. Never invent CSS selectors. Numbers stay stable while you remain on the same page.
3. **Read the result**: every action returns what changed ("Changes", new elements, messages, navigation). Use it to decide the next step without re-observing everything.
4. **Verify** the outcome before declaring the task done.
5. **Finish** by replying with the final result as text, without calling tools. If essential information is missing, ask the user as your final reply.

You may call several tools in the same response when they are independent (e.g. filling several fields of the same form). Stop after an action that changes page.

## Practical rules
- **Out of view**: when the observation reports elements BELOW or ABOVE, use \`browser_scroll\` before concluding an element does not exist.
- **Forms**: forms may have several tabs ([n] tab): fill every tab with required fields. After saving read the PAGE MESSAGES: on an error fix the indicated field and retry. Never repeat the same save without understanding why it failed.
- **Dropdowns**: use \`browser_select_ref\` for custom comboboxes too; if the option does not show up, click the dropdown and pick the option that appears in Changes.
- **Modal dialogs**: while a dialog is open the elements behind it are not listed; close or complete it first.
- **Data**: to extract structured data use \`extract_with_schema\` (or \`paginate_and_collect\` for lists across pages). Never invent values: report only what is on the page.
- **Procedures**: if a saved procedure matching the task is listed at the start, use \`run_procedure\`: it is faster and more reliable.
- **Plan**: for multi-phase tasks create a plan with \`update_plan\` and keep it updated.
- **Safety**: irreversible actions (deletions, payments, sending) are confirmed by the user through the extension: proceed normally; if the user rejects, stop and ask how to continue.
- Always reply in English, concisely.`;
}

function xmlProtocol(tools: ToolSpec[], lang: Lang): string {
  const list = tools
    .map(t => {
      const props = Object.keys(((t.schema as any).properties ?? {}) as Record<string, unknown>);
      const input = props.length === 0 ? '' : props.length === 1 && props[0] === 'input' ? ' · input: text' : ` · input JSON: {${props.join(', ')}}`;
      return `- ${t.name}: ${toolDescription(t, lang)}${input}`;
    })
    .join('\n');
  const header = lang === 'en'
    ? `## Tools\n${list}\n\n## Tool call format (MANDATORY)\nTo call a tool write exactly:\n\n<tool>tool_name</tool>\n<input>arguments (JSON object or text)</input>\n\nYou may write several calls one after another. Do not wrap them in code blocks. When the task is complete reply with plain text and no <tool> tag.`
    : `## Tool\n${list}\n\n## Formato chiamata tool (OBBLIGATORIO)\nPer chiamare un tool scrivi esattamente:\n\n<tool>nome_tool</tool>\n<input>argomenti (oggetto JSON o testo)</input>\n\nPuoi scrivere più chiamate una dopo l'altra. Non racchiuderle in blocchi di codice. Quando il compito è completo rispondi in testo semplice senza tag <tool>.`;
  const example = lang === 'en'
    ? `Example:\n<tool>browser_fill_ref</tool>\n<input>{"ref": 7, "text": "ACME srl"}</input>\n<tool>browser_click_ref</tool>\n<input>{"ref": 12}</input>`
    : `Esempio:\n<tool>browser_fill_ref</tool>\n<input>{"ref": 7, "text": "ACME srl"}</input>\n<tool>browser_click_ref</tool>\n<input>{"ref": 12}</input>`;
  return `${header}\n\n${example}`;
}

export class PromptManager {
  private tools: BrowserTool[];
  private startPageUrl = "";
  private startPageTitle = "";
  private profileAddendum = "";
  private pagePlaybook = "";

  constructor(tools: BrowserTool[]) {
    this.tools = tools ?? [];
  }

  /** Page where the task starts (static for the task; live URL goes in [STATE]). */
  setCurrentPageContext(url: string, title: string): void {
    this.startPageUrl = url;
    this.startPageTitle = title;
  }

  setProfileAddendum(addendum: string): void {
    this.profileAddendum = addendum ?? '';
  }

  /** Interaction playbook from the page profiler (framework-aware hints). */
  setPagePlaybook(playbook: string): void {
    this.pagePlaybook = playbook ?? '';
  }

  updateTools(tools: BrowserTool[]): void {
    this.tools = tools ?? [];
  }

  async getSystemPrompt(opts: PromptOptions): Promise<string> {
    const lang = opts.lang ?? (await getLang().catch(() => 'it' as Lang));

    let customPrompt = '';
    try {
      const result = await chrome.storage.local.get({ customSystemPrompt: '' });
      customPrompt = result.customSystemPrompt || '';
    } catch {
      // storage unavailable (e.g. in non-extension test context)
    }

    const base = customPrompt || (lang === 'en' ? coreEN(opts.vision) : coreIT(opts.vision));
    const protocol = opts.protocol === 'xml' ? `\n\n${xmlProtocol(opts.tools, lang)}` : '';
    return this.injectContext(`${base}${protocol}`, lang);
  }

  private injectContext(prompt: string, lang: Lang): string {
    let result = prompt;
    const now = new Date();
    const locale = lang === 'en' ? 'en-US' : 'it-IT';
    const dateLine = now.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const { os, modifier } = getOsInfo();
    result += lang === 'en'
      ? `\n\n## Context\nToday is ${dateLine}: compute relative dates ("tomorrow", "next week") from this. System: ${os} (shortcut modifier: ${modifier}).`
      : `\n\n## Contesto\nOggi è ${dateLine}: calcola le date relative ("domani", "settimana prossima") a partire da qui. Sistema: ${os} (modificatore scorciatoie: ${modifier}).`;
    if (this.startPageUrl) {
      result += lang === 'en'
        ? ` The task starts on ${this.startPageUrl}${this.startPageTitle ? ` ("${this.startPageTitle}")` : ''}. If the request does not name a page, it refers to this one.`
        : ` Il compito parte da ${this.startPageUrl}${this.startPageTitle ? ` ("${this.startPageTitle}")` : ''}. Se la richiesta non indica una pagina, si riferisce a questa.`;
    }
    if (this.pagePlaybook) result += `\n\n## ${lang === 'en' ? 'Page structure & strategy' : 'Struttura della pagina e strategia'}\n${this.pagePlaybook}`;
    if (this.profileAddendum) result += `\n\n## ${lang === 'en' ? 'Domain profile' : 'Profilo di dominio'}\n${this.profileAddendum}`;
    return result;
  }
}
