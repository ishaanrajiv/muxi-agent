/**
 * A throwaway streamable-HTTP MCP server for the smoke test and the Codex
 * fixture recorder. Three tools, all neutral:
 *
 *   - `echo { text }`: returns the text (read-only).
 *   - `ask { question }`: asks a person through an MCP elicitation, tagged as a
 *     question envelope, and returns the answer.
 *   - `save_note { text }`: pretends to save a note (a write, for declines).
 *
 * Stateful sessions (one transport per session id), so an elicitation's answer,
 * which arrives on a later POST, reaches the request that asked.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface EchoServer {
  url: string;
  /** Every tool call the server ran, in order. */
  calls: Array<{ tool: string; args: unknown }>;
  close(): Promise<void>;
}

function mcpServer(calls: EchoServer["calls"]): McpServer {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo the given text back unchanged.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      calls.push({ tool: "echo", args: { text } });
      return { content: [{ type: "text", text }] };
    },
  );
  server.registerTool(
    "ask",
    {
      description: "Ask the user one question and return their answer.",
      inputSchema: { question: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      calls.push({ tool: "ask", args: { question } });
      const res = await server.server.elicitInput({
        mode: "form",
        message: JSON.stringify({ kind: "question", question }),
        requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      });
      const answer = res.action === "accept" ? String(res.content?.answer ?? "") : `(no answer: ${res.action})`;
      return { content: [{ type: "text", text: answer }] };
    },
  );
  server.registerTool(
    "save_note",
    {
      description: "Save a short note.",
      inputSchema: { text: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ text }) => {
      calls.push({ tool: "save_note", args: { text } });
      return { content: [{ type: "text", text: "saved" }] };
    },
  );
  return server;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Start the server on a loopback port; `path` is the MCP endpoint. */
export async function startEchoServer(path = "/mcp"): Promise<EchoServer> {
  const calls: EchoServer["calls"] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http: Server = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith(path)) {
        res.writeHead(404).end();
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      const body = req.method === "POST" ? await bodyOf(req) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await mcpServer(calls).connect(transport);
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    calls,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
