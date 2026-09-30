/**
 * A small real MCP server that asks the person before it commits: `place_order` elicits a
 * confirmation (a form without fields), `choose_size` elicits a form a voice host can't show.
 * Sessionful (2025-11-25 Streamable HTTP): a server can only ask a client mid-call when it
 * remembers, from initialize, that the client can answer — so one server per session, not
 * createMcpHandler's stateless default.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

export interface ConsentFixture {
  url: string;
  token: string;
  /** The `capabilities` object from every `initialize` the server saw. */
  initCapabilities: unknown[];
  /** Orders actually placed. */
  orders: number;
  close(): Promise<void>;
}

export async function startConsentFixture(): Promise<ConsentFixture> {
  const token = "fixture-token";
  const state: ConsentFixture = { url: "", token, initCapabilities: [], orders: 0, close: async () => {} };

  const build = () => {
    const server = new McpServer({ name: "consent-fixture", version: "0.0.0" });
    server.registerTool("place_order", { description: "Place the grocery order." }, async (ctx) => {
      try {
        const r = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: "Place the order: two cartons of milk, seven dollars and forty cents?",
          requestedSchema: { type: "object", properties: {} },
        });
        if (r.action !== "accept") return { content: [{ type: "text" as const, text: "Okay, I did not place the order." }] };
      } catch {
        return { content: [{ type: "text" as const, text: "I can't ask you here, so I did not place the order." }], isError: true };
      }
      state.orders++;
      return { content: [{ type: "text" as const, text: "Order placed." }] };
    });
    server.registerTool("choose_size", { description: "Pick a size." }, async (ctx) => {
      const r = await ctx.mcpReq.elicitInput({
        mode: "form",
        message: "Which size?",
        requestedSchema: { type: "object", properties: { size: { type: "string", enum: ["small", "large"] } }, required: ["size"] },
      });
      return { content: [{ type: "text" as const, text: `Answer: ${r.action}` }] };
    });
    return server;
  };
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const handle = async (request: Request): Promise<Response> => {
    const id = request.headers.get("mcp-session-id");
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      const created = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => void sessions.set(sid, created),
      });
      await build().connect(created);
      transport = created;
    }
    return transport.handleRequest(request);
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    try {
      const parsed = JSON.parse(body.toString() || "null");
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (message?.method === "initialize") state.initCapabilities.push(message.params?.capabilities);
      }
    } catch {
      // not JSON: let the handler deal with it
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return state;
}
