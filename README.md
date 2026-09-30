# mcp-voice-simulator

> **Unofficial, community-built, not affiliated with or endorsed by Amazon.**
> Amazon's own docs state that ["Category SDK and MCP Toolkit are available to
> select partners only"](https://developer.amazon.com/docs/alexaplus/add-ons/home.html) —
> there is no public Alexa AI CLI, add-on registration, or device simulator
> available to most developers, including hackathon participants building for
> the Alexa+ track. This project does not use, wrap, or reverse-engineer any
> private Amazon tool or access. It's a clean-room implementation built only
> from published specs: MCP's own [Streamable HTTP
> transport](https://modelcontextprotocol.io/docs/latest/getting-started/intro),
> [OAuth 2.1](https://oauth.net/2.1/), PKCE
> ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), Protected Resource
> Metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), Authorization
> Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)), and
> Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)).

## What it does

Stands in for Alexa+ as the **MCP client**, in the same order a real Alexa+
integration would:

1. **Account linking** — OAuth 2.1 + PKCE, discovered via RFC 9728/8414 against
   *any* spec-compliant MCP server, not one hardcoded login flow. A human
   completes login in their own browser (the standard "loopback" pattern —
   the same one `gcloud auth login` and similar CLIs use), so it works
   whatever your server's login screen looks like.
2. **Tool discovery** — `tools/list` over MCP's Streamable HTTP transport.
3. **Per utterance** — pick a tool, call it, and speak the result back, via a
   pluggable **brain**.

Two brains ship ready to use, needing no per-server tuning because they pick
tools from whatever `tools/list` returns:

- **`createClaudeBrain`** — an Anthropic Messages API tool-use loop
  (needs `ANTHROPIC_API_KEY` and the peer dependency `@anthropic-ai/sdk`)
- **`createCursorBrain`** — a Cursor agent restricted to your server's MCP
  tools, so Cursor itself is the MCP client
  (needs `CURSOR_API_KEY` and the peer dependency `@cursor/sdk`)

There's no built-in "no API key" brain — picking a tool from open-ended
natural language needs an LLM unless you write one for your own specific
tools. `examples/scripted-brain.ts` shows exactly that pattern; copy it for
yours.

![Demo of the simulator against a sample MCP server](https://raw.githubusercontent.com/AlSayedGamal/mcp-voice-simulator/main/docs/demo.gif)

The clip is recorded against a **fictional** sample task tracker (`npm run demo`),
not a real application's API. It walks through account-linked status, tool
discovery (🖼 marks tools that declare a `ui://` view), a typed utterance, the
thinking ring, MCP call traces, the MCP Apps view on the device screen,
`tools/call` from the view, `ui/message` from the view, Confirm, and the
screen-shape picker.

To re-record: `npm run demo:record` (needs Playwright Chromium; writes `docs/demo.gif` and `docs/demo.mp4`).

## Quickstart (CLI)

```bash
npm install -g mcp-voice-simulator
npm install @anthropic-ai/sdk   # or @cursor/sdk, whichever brain you want

MCP_URL=https://your-server.example.com/mcp \
ANTHROPIC_API_KEY=sk-ant-... \
mcp-voice-simulator
```

Open the printed `http://127.0.0.1:8790` URL. It links an account against
your server, discovers its tools, and lets you type or speak utterances.

Linking is done in your browser: the page shows a **Link account** button with
a countdown (the URL is also printed in the terminal). If the login isn't
finished in time, the page says so and offers **Try again**, which starts a
new attempt. A failed attempt is never kept, so reloading the page also starts
a fresh one.

If your server doesn't implement RFC 7591 dynamic client registration (most
don't — it's optional even in a fully spec-compliant setup), set
`MCP_CLIENT_ID` to a pre-configured client id instead. If you already have a
bearer token and want to skip account linking entirely, set
`MCP_BEARER_TOKEN`.

| Env var | Purpose |
| --- | --- |
| `MCP_URL` | required — the MCP server's endpoint |
| `MCP_CLIENT_ID` | OAuth client id, if your server has no dynamic registration |
| `MCP_BEARER_TOKEN` | skip account linking entirely |
| `SIM_PORT` | default `8790` |
| `SIM_LINK_TIMEOUT_MS` | how long to wait for you to finish logging in, in milliseconds (default `300000`, 5 minutes). Servers that make you connect several providers on first use can need every minute of it |
| `SIM_UI`, `SIM_SANDBOX_PORT` | MCP Apps views, see [On-screen views](#on-screen-views-mcp-apps) |
| `SIM_ELICITATION`, `SIM_ELICITATION_TIMEOUT_MS` | spoken confirmations, see [Confirmations](#confirmations-elicitation) |
| `SIM_TTS` and `ELEVENLABS_*` | optional server-side voice, see [Voice](#voice-text-to-speech) |
| `SIM_BRAIN` | force `claude` or `cursor` (default: cursor if `CURSOR_API_KEY` is set, else claude) |
| `ANTHROPIC_API_KEY`, `SIM_MODEL` | for the Claude brain (`SIM_MODEL` default `claude-sonnet-5`) |
| `CURSOR_API_KEY`, `SIM_CURSOR_MODEL` | for the Cursor brain (`SIM_CURSOR_MODEL` default `composer-2.5`) |

## On-screen views (MCP Apps)

MCP servers can return a screen next to their spoken reply: a tool declares `_meta.ui.resourceUri: "ui://…"`, the host fetches that HTML resource and shows it in a sandboxed iframe, and the view talks back over `postMessage` ([MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/)). Alexa+'s MCP Toolkit docs say it supports MCP Apps through a webview. The simulator hosts these views on its device screen, so you can try yours:

- **Advertises support** (`extensions["io.modelcontextprotocol/ui"]`) when it connects, so servers that only expose view-enabled tools to capable clients show them.
- **Shows the view** of the last view-bearing tool call in a turn, fed `tool-input` then `tool-result` like a spec-compliant host. The Tools card marks tools that declare a view (🖼).
- **Answers the view's calls the way a host must:** `tools/call` only for tools whose `_meta.ui.visibility` includes `"app"` (anything else is refused, as the spec requires), `ui/message` becomes a new utterance to the brain (this is how a "Modify" button hands a change back to the assistant), and `ui/open-link` opens `https:` links only, after a confirm.
- **Enforces the spec's Content-Security-Policy** (deny-by-default, plus whatever the resource declares in `_meta.ui.csp`) and shows a note in the log when a view breaks it, e.g. a `fetch` to an origin it didn't declare.
- **Runs the view in the spec's two-origin sandbox:** the page is on `127.0.0.1:<port>` and a sandbox proxy is on `127.0.0.1:<port + 1>`, so the view can't reach the simulator's own origin or API.
- **Shows a note instead of failing** when a declared view can't be shown (wrong MIME type, resource missing).

| Env var | Purpose |
| --- | --- |
| `SIM_UI` | `on` (default) or `off`. Off advertises nothing and shows text only, which is what a host without MCP Apps does, so use it to test your server's text fallback. |
| `SIM_SANDBOX_PORT` | the sandbox proxy's port (default `SIM_PORT + 1`) |

**What this is and isn't.** It implements the MCP Apps *spec* host. It does not model Alexa's own webview: the Alexa docs only say a view renders "in the conversation view", so what Alexa+ enforces beyond the spec is unknown to us. The screen-shape picker under the device is for trying a view at different sizes, not a claim about any real device.

**Brain support.** With the Claude brain the simulator makes the tool calls and has the full result, so views work. The Cursor brain makes tool calls itself and doesn't hand back the full result; the simulator will not re-call a tool to get it (a mutating tool would repeat its side effects), so with Cursor it shows a note that the view can't be shown.

## Confirmations (elicitation)

A server that is about to do something consequential — place an order, spend money — can ask
the person first with MCP [elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation):
the host shows the question, the person answers, and the model never sees or supplies the yes.
Whether Alexa+ supports it is not documented, and Amazon's example client declares no
elicitation, so it is **off by default** and a server should fail closed without it. Opt in to
try the other path:

- **Advertises form elicitation** (`capabilities.elicitation.form`) when it connects.
- **Speaks the question** and shows Yes / No on the device screen while the turn runs; your
  answer goes back to the server. The trace log shows every question and its answer (❓).
- **Handles only what a voice host can:** a confirmation, i.e. a form with no fields or a single
  boolean field. Any other form, and URL mode, is **declined without asking** (a speaker can't
  render a form); no answer within the timeout is **cancel**. Nothing is ever accepted on your
  behalf.
- Works for both protocol eras: 2025-11-25 servers ask mid-call; on 2026-07-28 the client answers
  `input_required` rounds through the same handler.

| Env var | Purpose |
| --- | --- |
| `SIM_ELICITATION` | `off` (default) or `voice` |
| `SIM_ELICITATION_TIMEOUT_MS` | how long to wait for your answer before cancelling (default `60000`) |

**Brain support.** With the Claude brain the simulator's client makes the tool calls, so the
server's question reaches you. The Cursor brain calls tools through its own MCP client, which
this setting doesn't reach.

## Voice (text-to-speech)

By default the simulator speaks replies with your browser's built-in voice, which varies a lot by OS and browser. To use a better one, opt in to a server-side provider. **ElevenLabs** is built in:

```bash
SIM_TTS=elevenlabs \
ELEVENLABS_API_KEY=... \
ELEVENLABS_VOICE_ID=... \
MCP_URL=https://your-server.example.com/mcp ANTHROPIC_API_KEY=sk-ant-... \
mcp-voice-simulator
```

Find a voice id in the ElevenLabs voice library. The key stays in the Node process; the page only ever asks the local server for audio.

| Env var | Purpose |
| --- | --- |
| `SIM_TTS` | `browser` (default) or `elevenlabs`. Deliberately opt-in: a lone `ELEVENLABS_API_KEY` only prints a hint. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | required when `SIM_TTS=elevenlabs` |
| `ELEVENLABS_MODEL` | optional; ElevenLabs' own default model is used when unset |
| `ELEVENLABS_OUTPUT_FORMAT` | default `mp3_44100_128`; must be `mp3_*`, `opus_*` or `wav_*` (what a browser `<audio>` can play) |
| `ELEVENLABS_VOICE_SETTINGS` | optional JSON, e.g. `{"stability":0.5,"speed":1.1}` |
| `ELEVENLABS_BASE_URL` | optional; for a proxy or a test double |
| `SIM_TTS_MAX_CHARS` | longest reply sent to the provider (default 500, cut at a sentence end) |
| `SIM_TTS_CACHE` | how many synthesized clips to keep in memory (default 20; `0` disables), so a repeated reply isn't paid for twice |

**Privacy and cost.** With a server voice on, the text of each reply is sent to the provider. That text can include data your MCP server returned (ticket titles, meeting notes, names), which is why it's off by default. ElevenLabs bills by character; the cap and cache reduce accidental spend but are not a budget.

**If the provider fails** (bad key, out of credits, no network), that reply is spoken with the browser voice instead, the Connection card says why once, and the conversation carries on. After a bad-credentials error the page stops calling the provider until reload.

Add your own provider by implementing `TtsProvider` (one method) and passing it to `createServer`:

```ts
import { createServer, TtsError, type TtsProvider } from "mcp-voice-simulator";

const myVoice: TtsProvider = {
  name: "my-voice",
  cacheKey: "voice-a", // anything besides the text that changes the audio
  async synthesize(text, { signal }) {
    const res = await fetch("https://tts.example.com/say", { method: "POST", body: text, signal });
    if (!res.ok || !res.body) throw new TtsError("server", `TTS failed (${res.status})`, res.status);
    return { audio: res.body, contentType: "audio/mpeg" };
  },
};

createServer({ sessionManager, brain, tts: myVoice });
```

## Programmatic API

For a custom brain, or to embed the simulator in your own app:

```ts
import { McpSessionManager, createServer, createClaudeBrain } from "mcp-voice-simulator";

const sessionManager = new McpSessionManager({ mcpUrl: "https://your-server.example.com/mcp" });
const brain = createClaudeBrain({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  session: () => sessionManager.ensureSession(),
});

createServer({ sessionManager, brain, port: 8790 });
```

Write your own brain by implementing the `Brain` interface (`turn(utterance)`
→ `{ reply, trace }`, optional `reset()`) — see
`examples/scripted-brain.ts` for a complete keyword-routed example needing
no LLM at all.

The discovery and linking pieces are exported individually too
(`discoverProtectedResource`, `discoverAuthorizationServer`,
`registerDynamicClient`, `linkAccount`, `createPkce`) if you want to build
something other than the bundled server/UI on top of them.

## Conformance checker — "will this be a drop-in replacement?"

The point of building against published specs is that a server which passes
those checks today shouldn't need to change when real `alexa-ai` access
arrives. `mcp-voice-simulator-conformance` checks your MCP server against
Alexa+ MCP Toolkit's *documented* account-linking requirements — not by
guessing, but against claims traced to specific pages, each with an honest
confidence rating (see [docs/ALEXA_AI_CONTRACT.md](./docs/ALEXA_AI_CONTRACT.md)
for the full sourcing and what this deliberately does not attempt to fake):

```bash
npx mcp-voice-simulator-conformance https://your-server.example.com/mcp
```

Checks the spec transport, that unauthenticated requests get a 401, that
your authorization server's metadata advertises PKCE S256 (Amazon states
`alexa-ai deploy` is blocked without it — the highest-confidence check here),
and that `authorization_code` is an available grant type. One additional
check (whether the 401 omits a `WWW-Authenticate` header) is marked
`advisory` rather than `documented`, because that specific detail couldn't be
independently confirmed — see the contract doc before treating it as a hard
requirement.

```ts
import { checkAlexaPlusConformance } from "mcp-voice-simulator";

const report = await checkAlexaPlusConformance("https://your-server.example.com/mcp");
if (!report.passed) console.error(report.results.filter((r) => !r.pass));
```

## Architecture

```text
public/index.html   Browser UI: device-styled screen, mic (SpeechRecognition),
                     spoken replies, tool-call trace log
public/tts.js         The page's voice: browser speechSynthesis, or /api/tts audio
public/host.js        GENERATED browser MCP Apps host (AppBridge); source in host/
src/server.ts        HTTP API: /api/status, /api/relink, /api/turn, /api/reset, /api/tts, /api/ui/tool-call,
                     /api/elicitation
src/elicitation.ts   Elicitation as a spoken yes/no, fail closed (SIM_ELICITATION=voice)
src/tts/              Text-to-speech providers (ElevenLabs), cache, route
src/ui/               MCP Apps: view resolution, CSP, sandbox proxy server, routes
host/                 Browser host source (bundled to public/host.js by scripts/build-host.mjs)
src/session.ts        Owns account linking (the pending login, its expiry, retries) + the MCP connection
src/link.ts            OAuth 2.1 + PKCE loopback flow (RFC 8252-style)
src/discovery.ts        RFC 9728 / RFC 8414 / RFC 7591 discovery
src/mcp.ts             Thin @modelcontextprotocol/client wrapper
src/brains/            Pluggable utterance -> tool-call(s) -> reply strategies
src/conformance.ts     Checks a server against Alexa+'s *documented* requirements
examples/              A no-API-key scripted brain, as a pattern to copy
docs/ALEXA_AI_CONTRACT.md   Exact source + confidence behind every conformance check
```

## Origin

Extracted from a hackathon MCP server's own simulator, built for an Alexa+
track entry in an Amazon developer hackathon, after discovering the Alexa AI
CLI / MCP Toolkit isn't accessible to hackathon participants — a wall every
team in that track hits. This is the generalized, server-agnostic version.

## Contributing

Issues and PRs welcome — especially real-world reports of MCP servers whose
OAuth discovery doesn't fit the two well-known URL shapes `discovery.ts`
tries (see its doc comment), and additional brains for other model providers.

## License

[MIT](./LICENSE)
