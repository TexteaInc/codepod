import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

import * as trpcExpress from "@trpc/server/adapters/express";

import { createSetupWSConnection } from "./yjs/yjs-setupWS";
import { bindState, writeState } from "./yjs/yjs-blob";

import cors from "cors";
import { createSpawnerRouter, router } from "./spawner/trpc";
import { scanPythonsWithKernel } from "./util";

export async function startServer({ port, repoDir }) {
  console.log("starting server ..");
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  // support cors
  app.use(cors());
  // serve static files generated from UI
  const path = `${__dirname}/../public`;
  console.log("html path: ", path);
  app.use(express.static(path));

  const pythons = scanPythonsWithKernel();

  const yjsServerUrl = `ws://localhost:${port}/socket`;

  app.use(
    "/trpc",
    trpcExpress.createExpressMiddleware({
      router: router({
        spawner: createSpawnerRouter(yjsServerUrl),
      }),
    })
  );

  app.use(
    "/versions",
    function(_, res) {
      res.json({
        "versions": pythons,
      });
    }
  )

  const http_server = http.createServer(app);

  // Yjs websocket
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (...args) =>
    createSetupWSConnection(
      (doc, repoId) => bindState(doc, repoId, repoDir),
      writeState
    )(...args)
  );

  http_server.on("upgrade", async (request, socket, head) => {
    // You may check auth of request here..
    // See https://github.com/websockets/ws#client-authentication
    if (request.url) {
      wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit("connection", ws, request, { readOnly: false });
      });
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  });

  http_server.listen({ port }, () => {
    console.log(`🚀 Server ready at http://localhost:${port}`);
  });
}
