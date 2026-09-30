/**
 * Thin wrapper around @modelcontextprotocol/client's Streamable HTTP
 * transport — deliberately generic, no assumptions about which tools a
 * server exposes.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { ElicitationBroker, ElicitationParams, ElicitationRecord } from "./elicitation.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE, uiResourceUri } from "./ui/meta.js";

export interface McpTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Where MCP Apps declares a tool's view (`_meta.ui.resourceUri`) and who may call it. */
  _meta?: Record<string, unknown>;
}

export interface McpSession {
  client: Client;
  tools: McpTool[];
  /** Whether this session advertised MCP Apps support to the server. */
  ui: boolean;
  /** Set when this session advertised elicitation: questions go to the person through it. */
  elicitation?: ElicitationBroker;
}

export interface ConnectOptions {
  /** Advertise MCP Apps (`ui://` views) support. Default true. Off tests a server's text fallback. */
  ui?: boolean;
  /**
   * Advertise form elicitation and answer it as a spoken confirmation (see elicitation.ts).
   * Off by default, like a host that cannot render forms: the server must then fail closed.
   */
  elicitation?: ElicitationBroker;
}

export async function connectMcp(
  mcpUrl: string,
  accessToken: string,
  options: ConnectOptions = {},
): Promise<McpSession> {
  const ui = options.ui !== false;
  const capabilities = {
    ...(ui ? { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } } : {}),
    ...(options.elicitation ? { elicitation: { form: {} } } : {}),
  };
  const client = new Client(
    { name: "mcp-voice-simulator", version: "0.1.0" },
    Object.keys(capabilities).length ? { capabilities } : undefined,
  );
  const broker = options.elicitation;
  if (broker) client.setRequestHandler("elicitation/create", async (request) => broker.handle(request.params as ElicitationParams));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const { tools } = await client.listTools();
  return { client, tools, ui, ...(broker ? { elicitation: broker } : {}) };
}

/** The parts of a tool result beyond its text, which an MCP Apps view needs. */
export interface ToolCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export interface ToolCallTrace {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  ms: number;
  /** The full result. Absent when the brain (e.g. Cursor) makes the call itself. */
  result?: ToolCallResult;
  /** Set when the tool declares an MCP Apps view and this session supports it. */
  ui?: { resourceUri: string };
  /** Who made the call: the brain, or a view through the host. Default `brain`. */
  origin?: "brain" | "view";
  /** Questions the server asked the person during this call, and their answers. */
  elicitations?: ElicitationRecord[];
}

export async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  origin: "brain" | "view" = "brain",
): Promise<ToolCallTrace> {
  session.elicitation?.drain();
  const started = Date.now();
  const result = await session.client.callTool({ name, arguments: args });
  const asked = session.elicitation?.drain() ?? [];
  const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");

  const tool = session.tools.find((t) => t.name === name);
  const resourceUri = session.ui && tool ? uiResourceUri(tool) : undefined;

  return {
    tool: name,
    args,
    text,
    isError: Boolean(result.isError),
    ms: Date.now() - started,
    result: {
      content: result.content as unknown[] | undefined,
      structuredContent: result.structuredContent,
      isError: result.isError,
      _meta: result._meta,
    },
    ...(resourceUri ? { ui: { resourceUri } } : {}),
    origin,
    ...(asked.length ? { elicitations: asked } : {}),
  };
}
