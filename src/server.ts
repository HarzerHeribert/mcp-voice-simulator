/**
 * HTTP server: a tiny API (`/api/status`, `/api/relink`, `/api/turn`, `/api/reset`,
 * `/api/tts`, `/api/ui/tool-call`, `/api/elicitation`) plus the static browser UI in public/, wired to a Brain
 * and an McpSessionManager. With MCP Apps view support on, it also runs the
 * sandbox proxy on a second port (see ui/sandbox.ts).
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Brain } from "./brains/types.js";
import type { ElicitationAction, ElicitationBroker } from "./elicitation.js";
import { HTML_SECURITY_HEADERS, guardRequest } from "./security.js";
import type { McpSessionManager } from "./session.js";
import { createTtsRoute } from "./tts/route.js";
import type { TtsProvider } from "./tts/types.js";
import { createUiRoute } from "./ui/route.js";
import { createSandboxServer } from "./ui/sandbox.js";

const DEFAULT_PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface CreateServerOptions {
  sessionManager: McpSessionManager;
  brain: Brain;
  port?: number;
  publicDir?: string;
  /** Server-side voice (e.g. ElevenLabs). Omit to use the browser's own, as before. */
  tts?: TtsProvider;
  /** Longest reply sent to the TTS provider, in characters. Default 500. */
  ttsMaxChars?: number;
  /** How many synthesized clips to keep in memory. Default 20; 0 disables. */
  ttsCacheEntries?: number;
  /**
   * MCP Apps `ui://` view support. On by default; `false` shows text only, as a
   * host without MCP Apps would. The sandbox proxy listens on `sandboxPort`
   * (default: the server's port + 1) because the spec requires the host and the
   * sandbox to have different origins.
   */
  ui?: boolean | { sandboxPort?: number };
  /**
   * The broker the session manager answers elicitations through (SIM_ELICITATION=voice). The page
   * polls `GET /api/elicitation` while a turn runs and answers with `POST /api/elicitation`.
   */
  elicitation?: ElicitationBroker;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  // A handler that fails after it started answering (a static file vanishing
  // between writeHead and the read) can't send a fresh status; end the response
  // instead of throwing, which would leave the connection open.
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A client mistake, answered with `status` instead of being treated as a dead session. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

export function createServer(options: CreateServerOptions): http.Server {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  let lastAwaitingConfirm = false;
  const tts = createTtsRoute({
    provider: options.tts,
    maxChars: options.ttsMaxChars ?? 500,
    cacheEntries: options.ttsCacheEntries ?? 20,
  });

  const uiEnabled = options.ui !== false;
  const mainPort = options.port ?? 8790;
  const sandboxPort =
    typeof options.ui === "object" && options.ui.sandboxPort !== undefined
      ? options.ui.sandboxPort
      : mainPort === 0
        ? 0
        : mainPort + 1;
  const sandbox = uiEnabled ? createSandboxServer({ port: sandboxPort }) : undefined;
  const ui = createUiRoute({
    enabled: uiEnabled,
    sessionManager: options.sessionManager,
    brainName: options.brain.name,
    sandboxOrigin: () => {
      const address = sandbox?.address();
      return typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : undefined;
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      // The port is only known once we're listening (it may have been 0).
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 8790);
      const guard = guardRequest(req, port);
      if (!guard.ok) return json(res, guard.status, { error: guard.error });

      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      if (req.method === "GET" && path === "/api/status") {
        const common = {
          mcpUrl: options.sessionManager.mcpUrl,
          brain: options.brain.name,
          tts: { name: tts.name },
          ui: ui.status(),
          elicitation: options.elicitation ? "voice" : "off",
        };
        // Doesn't wait for the human to finish logging in, so the page can show the link meanwhile.
        const link = await options.sessionManager.linkStatus();
        if (link.state === "pending") {
          return json(res, 200, {
            linked: false,
            ...common,
            linking: true,
            ...(link.url ? { linkUrl: link.url } : {}),
            linkExpiresAt: link.expiresAt.toISOString(),
          });
        }
        if (link.state === "failed") {
          return json(res, 200, {
            linked: false,
            ...common,
            linkFailed: true,
            linkTimedOut: link.timedOut,
            error: link.error,
          });
        }
        try {
          const session = await options.sessionManager.ensureSession();
          return json(res, 200, {
            linked: true,
            ...common,
            tools: session.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              ...(ui.toolView(t) ? { ui: ui.toolView(t) } : {}),
            })),
          });
        } catch (err) {
          return json(res, 200, {
            linked: false,
            ...common,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (req.method === "POST" && path === "/api/relink") {
        // A new login means a new token, which the brain may be holding the old one of.
        options.sessionManager.relink();
        await options.brain.reset?.();
        lastAwaitingConfirm = false;
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/api/turn") {
        const body = (await readJsonBody(req)) as { utterance?: unknown };
        if (typeof body.utterance !== "string" || !body.utterance.trim()) {
          return json(res, 400, { error: "utterance is required" });
        }
        const cleaned = body.utterance.replace(/^\s*(alexa|hey\s+\w+)[,.!]?\s*/i, "").trim();
        const { reply, trace } = await options.brain.turn(cleaned);
        lastAwaitingConfirm = /\b(confirm|say yes|shall i|want me to)\b/i.test(reply);
        return json(res, 200, {
          reply,
          trace,
          brain: options.brain.name,
          awaitingConfirm: lastAwaitingConfirm,
          ...(await ui.forTurn(trace)),
        });
      }

      if (req.method === "GET" && path === "/api/elicitation") {
        return json(res, 200, { pending: options.elicitation?.current() ?? null });
      }

      if (req.method === "POST" && path === "/api/elicitation") {
        const body = (await readJsonBody(req)) as { id?: unknown; action?: unknown };
        const actions: ElicitationAction[] = ["accept", "decline", "cancel"];
        if (typeof body.id !== "string" || !actions.includes(body.action as ElicitationAction)) {
          throw new HttpError(400, "id and action (accept, decline or cancel) are required");
        }
        const ok = options.elicitation?.answer(body.id, body.action as ElicitationAction) ?? false;
        return json(res, ok ? 200 : 404, ok ? { ok } : { error: "no such question (answered or timed out)" });
      }

      if (req.method === "POST" && path === "/api/tts") {
        return await tts.handle(res, await readJsonBody(req));
      }

      if (req.method === "POST" && path === "/api/ui/tool-call") {
        return await ui.handleToolCall(res, await readJsonBody(req));
      }

      if (req.method === "POST" && path === "/api/reset") {
        await options.brain.reset?.();
        lastAwaitingConfirm = false;
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS });
        return res.end(await readFile(join(publicDir, "index.html")));
      }

      if (req.method === "GET" && path === "/tts.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" });
        return res.end(await readFile(join(publicDir, "tts.js")));
      }

      if (req.method === "GET" && path === "/host.js") {
        const file = await readFile(join(publicDir, "host.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" });
        return res.end(file);
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      // A dead session (server restarted, token expired) should relink next turn.
      options.sessionManager.invalidate();
      await options.brain.reset?.();
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("close", () => sandbox?.close());
  server.listen(mainPort, "127.0.0.1");
  return server;
}
