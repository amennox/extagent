# DomMotion

> Open-source Chrome extension that controls your browser with natural language.

DomMotion is an AI agent that runs directly inside your browser. It connects to any OpenAI-compatible LLM endpoint (OpenAI, Azure, Ollama, vLLM, LM Studio, …) and uses Playwright to perform actions on web pages.

This project is an **evolutionary fork of [BrowserBee](https://github.com/parsaghaffari/browserbee)**. DomMotion keeps the spirit and architecture of the original project, with a stronger focus on structured data extraction, B2B automation, and data sovereignty.

---

## ✨ Features

- **Natural-language browser control** — navigate, click, fill forms, extract data.
- **Set-of-Marks perception** — every observation numbers the visible interactive elements (main page, iframes and open shadow roots); on vision models the same numbers are drawn on a screenshot that is sent to the model.
- **Robust agent loop** — native function calling (several actions per turn), compact context that drops stale page dumps, a per-step state message with the live plan, loop detection, automatic fallback to a text protocol for endpoints without tools.
- **Procedures** — record an operation once (or save a successful agent task), edit its steps and parameters, run it again without an LLM. AI steps and failed steps are handed to the agent, then the procedure resumes.
- **Structured extraction** — JSON-schema extraction with validation, also across paginated lists.
- **Explicit approval** — the extension (not the model) asks for confirmation before deletions, payments, sending or final confirmations.
- **Privacy-first** — data stays in the browser; passwords and sensitive values are never stored in procedures; LLM calls go only to the endpoint you configure.
- **OpenAI-compatible providers** — OpenAI, Azure, Ollama, vLLM, LM Studio and more.

---

## 🚀 Installation

### From source

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `dist/` folder

For hot-reload development, see the scripts in `package.json` and the inline help in the options page.

---

## ⚙️ Configuration

After installation, open the extension options and configure your LLM endpoint:

- **Base URL** (e.g. `http://localhost:8000/v1`)
- **API Key** (optional for local endpoints)
- **Model** and preferred profile

Credentials are saved locally in the browser storage. You can also create multiple model profiles and route different features to different profiles.

---

## 🕹️ Usage

1. Open the side panel by clicking the DomMotion icon or pressing `Alt+Shift+E`.
2. Type what you want to do in natural language (e.g. *“Extract name, VAT number and contact of every supplier on this page”*).
3. Confirm risky actions when prompted.
4. Export results as JSON, CSV, or copy them to the clipboard.

For vision models (GPT-4o, Qwen2.5-VL, Llama 3.2 Vision, …) enable **Vision model** in the model profile: observations then include an annotated screenshot.

---

## 🧠 How the agent works

Each step the agent sees:

- a **static system prompt** (built once per task, so prefix caching works);
- the **task message**, with notes from previous tasks on the same site and the list of saved procedures for it;
- the **turns so far**: its own decisions are always kept, but only the latest observation of each kind is kept in full; older page dumps become a one-line placeholder, and very old turns are summarized when the context gets full;
- a fresh **[STATE] message**: active tab and URL, plan checklist, open browser dialogs, loop warnings, and (vision) the current annotated screenshot.

The model acts on element **numbers** (`browser_click_ref`, `browser_fill_ref`, `browser_select_ref`, …). Numbers stay stable while it stays on the same page, and each action returns what changed on the page, including validation messages and native form errors. If it repeats the same action without progress it is warned, then stopped with an explanation.

Main settings (Options → General): maximum steps (default 60), **action confirmations** (risky only / also saves / never), **advanced tools** (low-level CSS/DOM/mouse tools, hidden by default).

---

## 🧩 Procedures

A procedure is an ordered list of steps with typed parameters and a run history. It replaces the previous "recordings" and Markdown "skills"; existing ones are migrated automatically the first time the new version starts.

### Creating one

- **Record**: side panel → *Record* → *Start recording*, perform the operation, *Stop and save*. Each click, filled field, selection and Enter becomes a step with a thumbnail of the element. Recording works inside iframes and web components and survives page navigations.
- **From a successful task**: after the agent completes a task, the side panel offers *Save as procedure*.
- **By hand or import**: Options → Procedures → *New* / *Import*.

### Editing

Options → Procedures shows every procedure with its last outcome. In the editor you can rename steps, change values, reorder, add steps (including **AI steps**: an instruction the agent executes), mark steps optional, force or disable confirmation per step, and edit the locators.

- *Make parameter* turns a typed value into `{{name}}` (the recorded value becomes the default).
- *Suggest name and parameters (AI)* proposes them in one call.
- Passwords, IBANs, payment cards and tax codes are **never stored**: they become required parameters (`secret` type for passwords).
- Expressions: `{{oggi}}` / `{{today}}`, `{{oggi+7g:GG/MM/AAAA}}`, `{{now}}`, and variables saved by previous steps (`{{orders.total}}`).
- *Run up to here* and *Test this step* act on the most recently used web tab.

| Step | Value | Effect |
|------|-------|--------|
| `navigate` | URL | Opens the page |
| `click` | — | Clicks the element |
| `fill` | text / `{{param}}` | Fills the field |
| `select` | option | Picks an option (native or custom dropdown) |
| `check` | `true` / `false` | Checks or unchecks |
| `press` | key | Presses a key on the element |
| `wait` | seconds | Waits (empty = until the page is stable) |
| `scroll` | `down`/`up`/`top`/`bottom` | Scrolls, or brings the element into view |
| `extract` | JSON schema | Extracts structured data into a variable |
| `ai` | instruction | Done by the agent |

### Running

- **Side panel**: the procedures of the current site appear as buttons above the input; one click, parameters if needed.
- **Agent**: it receives the site's procedures at the start of a task and calls `run_procedure`. If a step fails it completes that step itself and resumes with `startAt`.
- Elements are located with several strategies: recorded selectors, ARIA role and name, label, visible text, inside the recorded iframe.

### Sharing

Export as JSON (exchange format, thumbnails included) or as Markdown (readable documentation).

---

## 🛠️ Development

Key scripts:

```bash
npm run dev        # Build and watch with static copy
npm run build      # Production build
npm run lint       # ESLint check
npm test           # Unit + end-to-end tests
```

The extension is built with Vite. React/TypeScript source code lives in `src/`, static assets in `public/`, and build output in `dist/`.

Main modules:

| Path | Role |
|------|------|
| `src/agent/ExecutionEngine.ts` | Observe → act loop, protocol fallback, approvals, loop detection |
| `src/agent/AgentState.ts` | Turn transcript, context compaction, [STATE] message, XML parser |
| `src/agent/toolCatalog.ts` | Tool tiers, JSON schemas, descriptions |
| `src/agent/tools/pageMapTools.ts` | Set-of-Marks perception and ref-based actions |
| `src/procedures/` | Procedure model, store, builder, runner, migration |
| `src/background/recordingSession.ts` | On-demand recording with thumbnails |
| `src/background/procedureController.ts` | Direct procedure runs with agent fallback |

### Tests

`tests/unit` runs in jsdom. `tests/e2e` runs on a real Chromium through `playwright-core`: page perception on HTML scenarios (multi-tab form, custom dropdown, modal, iframe, shadow DOM, long page, inner scroll container), the agent engine driven by a scripted model, record → build → replay of procedures, and the **built extension** (`dist/`) loaded in Chromium. End-to-end suites are skipped when no Chromium build is installed:

```bash
npx playwright-core install chromium
npm run build && npm test
```

---

## 📄 License

Distributed under the **Apache 2.0** license. See [`LICENSE`](LICENSE).

DomMotion is a fork derived from [BrowserBee](https://github.com/parsaghaffari/browserbee) by Parsa Ghaffari, released under Apache 2.0. Attributions to the original projects and third-party libraries are listed in [`NOTICE`](NOTICE).

---

## 🙏 Acknowledgements

- [BrowserBee](https://github.com/parsaghaffari/browserbee) — original project by Parsa Ghaffari.
- [playwright-crx](https://github.com/ruifigueira/playwright-crx) — Playwright inside a Chrome extension.
- [playwright-mcp](https://github.com/microsoft/playwright-mcp) — browser tool implementations.
- [Cline](https://github.com/cline/cline) — inspiration for the agent-in-the-browser approach.
- [DaisyUI](https://daisyui.com/) and [Tailwind CSS](https://tailwindcss.com/) — UI.
- [Lucide](https://lucide.dev/) — icons.

---

*DomMotion is an independent project, not affiliated with BrowserBee or its original maintainers.*
