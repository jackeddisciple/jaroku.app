import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface SeenRequest {
  method: string;
  path: string;
  rpc: string | null;
  auth: string | null;
  tool: string | null;
}

export interface ScriptedRequest {
  method: string;
  path: string;
  rpc: string | null;
  id: unknown;
  body: string;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface ScriptedOptions {
  token?: string | null;
  tools?: unknown;
  serverInfo?: Record<string, unknown>;
  hook?: (request: ScriptedRequest) => boolean | Promise<boolean>;
}

export interface ScriptedServer {
  url: string;
  origin: string;
  seen: SeenRequest[];
  set: (patch: Partial<ScriptedOptions>) => void;
  close: () => Promise<void>;
}

const HEAD = { "content-type": "application/json", "mcp-session-id": "scripted" };

export function replyResult(res: ServerResponse, id: unknown, result: unknown): void {
  res.writeHead(200, HEAD).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

export const DEFAULT_TOOLS = [
  { name: "read_page", description: "Reads a page.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "send_message", description: "Sends a message.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];

export function startScriptedServer(initial: ScriptedOptions = {}): Promise<ScriptedServer> {
  let options: ScriptedOptions = { ...initial };
  const seen: SeenRequest[] = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        let rpc: { method?: string; id?: unknown; params?: { name?: unknown } } = {};
        try {
          rpc = JSON.parse(body) as typeof rpc;
        } catch {
          rpc = {};
        }
        const path = new URL(req.url ?? "/", "http://scripted").pathname;
        const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : null;
        seen.push({
          method: req.method ?? "",
          path,
          rpc: typeof rpc.method === "string" ? rpc.method : null,
          auth,
          tool: typeof rpc.params?.name === "string" ? rpc.params.name : null,
        });

        if (options.hook) {
          const handled = await options.hook({
            method: req.method ?? "",
            path,
            rpc: rpc.method ?? null,
            id: rpc.id,
            body,
            req,
            res,
          });
          if (handled) return;
        }

        if (options.token && auth !== `Bearer ${options.token}`) {
          res.writeHead(401, { ...HEAD, "www-authenticate": 'Bearer realm="scripted"' });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "Unauthorized" } }));
          return;
        }
        if (req.method === "DELETE") return void res.writeHead(200, HEAD).end("{}");
        if (req.method !== "POST") return void res.writeHead(405, HEAD).end("{}");
        if (rpc.method === "initialize") {
          return replyResult(res, rpc.id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: options.serverInfo ?? { name: "scripted", version: "1.0" },
          });
        }
        if (rpc.method === "notifications/initialized") return void res.writeHead(202, HEAD).end();
        if (rpc.method === "tools/list") {
          return replyResult(res, rpc.id, { tools: "tools" in options ? options.tools : DEFAULT_TOOLS });
        }
        if (rpc.method === "tools/call") {
          return replyResult(res, rpc.id, { content: [{ type: "text", text: "ran" }], isError: false });
        }
        res.writeHead(200, HEAD).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no" } }));
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        origin: `http://127.0.0.1:${port}`,
        seen,
        set: (patch) => {
          options = { ...options, ...patch };
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
