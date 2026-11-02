import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createErrorEnvelope, generateRequestId } from "../protocol/index.ts";
import { handleRequest, type HandlerOptions } from "./handler.ts";
import type { SharedNetRepository } from "./repository.ts";

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  target.end(Buffer.from(await response.arrayBuffer()));
}

export function createSharedNetDevServer(store?: SharedNetRepository, options: HandlerOptions = {}) {
  return createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? "127.0.0.1";
      const url = new URL(incoming.url ?? "/", `http://${host}`);
      const body = await readBody(incoming);
      const request = new Request(url, {
        method: incoming.method ?? "GET",
        headers: requestHeaders(incoming),
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      await writeResponse(await handleRequest(request, store, options), outgoing);
    } catch {
      await writeResponse(
        new Response(
          JSON.stringify(createErrorEnvelope("internal_error", generateRequestId())),
          { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
        ),
        outgoing,
      );
    }
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3001;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectExecution()) {
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createSharedNetDevServer();
  server.listen(parsePort(process.env.PORT), host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : parsePort(process.env.PORT);
    process.stdout.write(`sharednet-v1 listening http://${host}:${actualPort}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
