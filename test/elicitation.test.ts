import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ElicitationBroker, confirmationField } from "../src/elicitation.js";
import { callTool, connectMcp } from "../src/mcp.js";
import { startConsentFixture, type ConsentFixture } from "./fixtures/consent-server.js";

const until = async (check: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("confirmationField", () => {
  it("accepts a form without fields or with one boolean, nothing else", () => {
    expect(confirmationField({ message: "ok?", requestedSchema: { properties: {} } })).toBe("");
    expect(confirmationField({ message: "ok?" })).toBe("");
    expect(confirmationField({ message: "ok?", requestedSchema: { properties: { confirm: { type: "boolean" } } } })).toBe("confirm");
    expect(confirmationField({ message: "size?", requestedSchema: { properties: { size: { type: "string" } } } })).toBeUndefined();
    expect(confirmationField({ mode: "url", message: "log in" })).toBeUndefined();
  });
});

describe("ElicitationBroker", () => {
  it("returns the person's answer, with the boolean set on accept", async () => {
    const broker = new ElicitationBroker();
    const result = broker.handle({ message: "Place it?", requestedSchema: { properties: { confirm: { type: "boolean" } } } });
    await until(() => broker.current());
    expect(broker.answer(broker.current()!.id, "accept")).toBe(true);
    expect(await result).toEqual({ action: "accept", content: { confirm: true } });
    expect(broker.drain()).toEqual([{ message: "Place it?", action: "accept" }]);
  });

  it("fails closed: other forms and URL mode are declined without asking", async () => {
    const broker = new ElicitationBroker();
    expect(await broker.handle({ message: "Which size?", requestedSchema: { properties: { size: { type: "string" } } } })).toEqual({ action: "decline" });
    expect(await broker.handle({ mode: "url", message: "Log in" })).toEqual({ action: "decline" });
    expect(broker.current()).toBeNull();
    expect(broker.drain().map((r) => r.reason)).toEqual(["not-a-confirmation", "url-mode"]);
  });

  it("cancels when nobody answers in time", async () => {
    const broker = new ElicitationBroker(30);
    expect(await broker.handle({ message: "Place it?" })).toEqual({ action: "cancel" });
    expect(broker.drain()).toEqual([{ message: "Place it?", action: "cancel", reason: "timeout" }]);
    expect(broker.answer("late", "accept")).toBe(false);
  });
});

describe("elicitation against a real server", () => {
  let fixture: ConsentFixture;
  beforeEach(async () => (fixture = await startConsentFixture()));
  afterEach(() => fixture.close());

  it("off by default: the capability is not declared, and the server cannot ask", async () => {
    const session = await connectMcp(fixture.url, fixture.token, { ui: false });
    const trace = await callTool(session, "place_order", {});
    expect(JSON.stringify(fixture.initCapabilities.at(-1) ?? {})).not.toContain("elicitation");
    expect(trace.text).toContain("did not place");
    expect(fixture.orders).toBe(0);
  });

  it("voice: the person's yes places the order, and the question lands in the trace", async () => {
    const broker = new ElicitationBroker();
    const session = await connectMcp(fixture.url, fixture.token, { ui: false, elicitation: broker });
    expect(fixture.initCapabilities.at(-1)).toMatchObject({ elicitation: { form: {} } });
    const call = callTool(session, "place_order", {});
    await until(() => broker.current());
    expect(broker.current()!.message).toContain("seven dollars and forty cents");
    broker.answer(broker.current()!.id, "accept");
    const trace = await call;
    expect(trace.text).toBe("Order placed.");
    expect(trace.elicitations).toEqual([{ message: "Place the order: two cartons of milk, seven dollars and forty cents?", action: "accept" }]);
    expect(fixture.orders).toBe(1);
  });

  it("voice: a no holds the order", async () => {
    const broker = new ElicitationBroker();
    const session = await connectMcp(fixture.url, fixture.token, { ui: false, elicitation: broker });
    const call = callTool(session, "place_order", {});
    await until(() => broker.current());
    broker.answer(broker.current()!.id, "decline");
    expect((await call).text).toContain("did not place");
    expect(fixture.orders).toBe(0);
  });

  it("voice: a form with fields is declined without asking the person", async () => {
    const broker = new ElicitationBroker();
    const session = await connectMcp(fixture.url, fixture.token, { ui: false, elicitation: broker });
    const trace = await callTool(session, "choose_size", {});
    expect(trace.text).toBe("Answer: decline");
    expect(trace.elicitations).toEqual([{ message: "Which size?", action: "decline", reason: "not-a-confirmation" }]);
  });
});

import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Brain } from "../src/brains/types.js";
import { createServer } from "../src/server.js";
import type { McpSessionManager } from "../src/session.js";

describe("/api/elicitation", () => {
  let server: http.Server;
  let base: string;
  const broker = new ElicitationBroker();
  beforeEach(async () => {
    const brain: Brain = { name: "test", turn: async () => ({ reply: "", trace: [] }) };
    const sessionManager = { mcpUrl: "https://mcp.example.com/mcp", linkStatus: async () => ({ state: "linked" }), ensureSession: async () => ({ tools: [] }), invalidate: () => {} } as unknown as McpSessionManager;
    server = createServer({ sessionManager, brain, port: 0, ui: false, elicitation: broker });
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  const post = (body: unknown) => fetch(`${base}/api/elicitation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("shows the open question and takes the person's answer once", async () => {
    expect(await (await fetch(`${base}/api/elicitation`)).json()).toEqual({ pending: null });
    const result = broker.handle({ message: "Place it?" });
    await until(() => broker.current());
    const { pending } = (await (await fetch(`${base}/api/elicitation`)).json()) as { pending: { id: string; message: string } };
    expect(pending.message).toBe("Place it?");
    expect((await post({ id: pending.id, action: "decline" })).status).toBe(200);
    expect(await result).toEqual({ action: "decline" });
    expect((await post({ id: pending.id, action: "accept" })).status).toBe(404);
    expect((await post({ id: pending.id, action: "maybe" })).status).toBe(400);
  });

  it("reports the mode in /api/status", async () => {
    expect(await (await fetch(`${base}/api/status`)).json()).toMatchObject({ elicitation: "voice" });
  });
});
