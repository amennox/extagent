# DomMotion

> Open-source Chrome extension that controls your browser with natural language.

DomMotion is an AI agent that runs directly inside your browser. It connects to any OpenAI-compatible LLM endpoint (OpenAI, Azure, Ollama, vLLM, LM Studio, …) and uses Playwright to perform actions on web pages.

This project is an **evolutionary fork of [BrowserBee](https://github.com/parsaghaffari/browserbee)**. DomMotion keeps the spirit and architecture of the original project, with a stronger focus on structured data extraction, B2B automation, and data sovereignty.

---

## ✨ Features

- **Natural-language browser control** — navigate, click, fill forms, extract data.
- **Structured extraction** — define JSON schemas and let the agent collect data from pages.
- **Markdown skills** — write reusable automation workflows as `.md` files and run them with a single command.
- **Local memory** — save successful patterns to IndexedDB and reuse them later.
- **Explicit approval** — critical actions (submits, deletions, purchases) require your confirmation.
- **Privacy-first** — data stays in the browser; LLM calls go only to the endpoint you configure.
- **OpenAI-compatible providers** — use OpenAI, Azure, local servers, Ollama, vLLM, LM Studio, and more.

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
3. Confirm critical actions when prompted.
4. Export results as JSON, CSV, or copy them to the clipboard.

---

## 🧩 Writing DomMotion skills

Skills are Markdown documents that describe reusable browser-automation workflows. They are stored locally and can be run from the side panel or imported/exported as `.md` files.

### File structure

Every skill must start with a YAML frontmatter block delimited by `---`:

```markdown
---
title: Collect public tenders
description: Extract title, deadline and CPV code from the public tenders page
params: [section]
---

## Steps

1. Navigate to the target portal
   - `navigate: https://example.com/tenders?section={{section}}`

2. Extract structured data
   - `extract: {"type":"object","properties":{"title":{"type":"string"},"deadline":{"type":"string"},"cpv":{"type":"string"}}}`
   - `export: json`
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Unique name of the skill. This is what you type in the side panel to run it. |
| `description` | yes | Short one-line summary shown in the skill list. |
| `params` | no | Comma-separated list of parameter names. They can be referenced in commands as `{{paramName}}`. |

### Step commands

Step commands must be wrapped in backticks and follow the pattern `` `command: payload` ``. Lines that do not match a command are collected as free-text notes for the LLM.

| Command | Purpose | Example |
|---------|---------|---------|
| `navigate` | Open a URL. | `` `navigate: https://example.com` `` |
| `extract` | Extract structured data using a JSON schema. | `` `extract: {"type":"object","properties":{"name":{"type":"string"}}}` `` |
| `paginate` | Collect data across multiple pages. | `` `paginate: {"nextSelector":".next","maxPages":5}` `` |
| `fill` | Fill a form from a structured payload. | `` `fill: {"email":"user@example.com"}` `` |
| `play` | Replay a saved recording. | `` `play: login-sequence` `` |
| `export` | Export collected data. Supported values include `json` and `csv`. | `` `export: csv` `` |
| `compute` | Run a lightweight data transformation. | `` `compute: normalize` `` |

### Variables and parameters

- **Parameters** are declared in the frontmatter and substituted at runtime. Use them anywhere in the body:
  ```markdown
  params: [category, maxResults]
  ---
  - `navigate: https://example.com/items?category={{category}}&limit={{maxResults}}`
  ```

- **Result variables** capture the output of a step and can be referenced later:
  ```markdown
  - `extract: {"type":"object","properties":{"total":{"type":"number"}}}` → save as {{summary}}
  - `compute: {{summary.total}} * 1.22`
  ```

### Tips for reliable skills

1. **Keep the frontmatter minimal** — only `title`, `description`, and optionally `params`.
2. **Use one command per bullet** — this makes parsing predictable.
3. **Add free-text context** between commands; the LLM uses it as a fallback if a step fails.
4. **Reference exact selectors or URLs** when the portal structure is known.
5. **Test with a small JSON schema first**, then expand it once extraction works.
6. **Use parameters for reusable values** (credentials, categories, dates) instead of hard-coding them.

### Running a skill

Open the side panel and type a prompt like:

```text
Run skill "Collect public tenders" with section "it-services"
```

DomMotion will match the skill by title, substitute the parameters, and execute the steps in order.

---

## 🛠️ Development

Key scripts:

```bash
npm run dev        # Build and watch with static copy
npm run build      # Production build
npm run lint       # ESLint check
npm test           # Run unit tests
```

The extension is built with Vite. React/TypeScript source code lives in `src/`, static assets in `public/`, and build output in `dist/`.

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
