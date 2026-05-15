import * as http from "node:http";
import { WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { INDEX_HTML } from "./webui.js";
import { Blackboard } from "../core/blackboard.js";

export const serverEvents = new EventEmitter();

export function startMorphServer(bb: Blackboard, port: number = 4040): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS" && (req.url === "/api/approve" || req.url === "/api/reject")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && (req.url === "/api/approve" || req.url === "/api/reject")) {
      let body = "";
      req.on("data", chunk => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const event = req.url === "/api/approve" ? "approve" : "reject";
          serverEvents.emit(event, data.phase);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end("Bad Request");
        }
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(INDEX_HTML);
  });

  const wss = new WebSocketServer({ server });
  
  bb.subscribe(() => {
    const state = JSON.stringify(bb.getState());
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(state);
    }
  });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify(bb.getState()));
  });

  server.listen(port);
  return server;
}
