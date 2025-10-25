import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PORT } from "../config/server-config.js";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs';
import path from 'path';

// Create a logger that won't interfere with stdio transport
export const logger = {
  _stdioMode: process.env.TRANSPORT === 'stdio',
  _logFile: process.env.LOG_FILE || './mcp-server.log',
  
  _writeToFile(message: string) {
    try {
      fs.appendFileSync(this._logFile, `${new Date().toISOString()} - ${message}\n`);
    } catch (err) {
      // Fallback to stderr if file writing fails
      process.stderr.write(`${message}\n`);
    }
  },

  log: (message: string) => {
    if (logger._stdioMode) {
      logger._writeToFile(`[LOG] ${message}`);
    } else {
      console.log(message);
    }
  },
  
  info: (message: string) => {
    if (logger._stdioMode) {
      logger._writeToFile(`[INFO] ${message}`);
    } else {
      console.log(message);
    }
  },
  
  warn: (message: string) => {
    if (logger._stdioMode) {
      logger._writeToFile(`[WARN] ${message}`);
    } else {
      console.warn(message);
    }
  },
  
  error: (message: string, error?: unknown) => {
    let errorMsg = message;
    if (error instanceof Error) {
      errorMsg += ` ${error.stack || error.message}`;
    } else if (error !== undefined) {
      errorMsg += ` ${String(error)}`;
    }
    
    if (logger._stdioMode) {
      logger._writeToFile(`[ERROR] ${errorMsg}`);
    } else {
      console.error(errorMsg);
    }
  }
};

/**
 * Setup stdio transport for command line usage
 * @param server MCP server instance
 */
export function setupStdioTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  
  return server.connect(transport).then(() => {
    logger.info("Open Food Facts MCP Server started with stdio transport");
  }).catch(error => {
    logger.error("Error starting MCP server with stdio transport:", error);
    process.exit(1);
  });
}

/**
 * Setup HTTP/SSE transport for web-based clients
 * @param server MCP server instance
 * @param app Express application
 */
export function setupHttpTransport(server: McpServer, app: express.Application): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      app.use(cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id']
      }));
      app.use(express.json({ limit: "2mb" }));

      // Simple request logger so we can SEE if clients are hitting us
      app.use((req, _res, next) => {
        logger.info(`${req.method} ${req.path}`);
        next();
      });

      app.get("/", (_req, res) => res.send("Open Food Facts MCP Server is running"));
      app.get("/healthz", (_req, res) => res.status(200).send("ok"));

      // Allow preflight
      app.options("/mcp", cors());

      // Map to store transports by session ID
      const transports: Record<string, StreamableHTTPServerTransport> = {};

      // Handle POST requests (initialization and regular requests)
      app.post("/mcp", async (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId) {
          logger.info(`Received MCP request for session: ${sessionId}`);
        }

        try {
          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports[sessionId]) {
            // Reuse existing transport for this session
            transport = transports[sessionId];
          } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - create new transport
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
              onsessioninitialized: (newSessionId: string) => {
                logger.info(`Session initialized with ID: ${newSessionId}`);
                transports[newSessionId] = transport;
              }
            });

            // Set up cleanup handler
            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && transports[sid]) {
                logger.info(`Transport closed for session ${sid}, removing from transports map`);
                delete transports[sid];
              }
            };

            // Connect the transport to the MCP server
            await server.connect(transport);
          } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided'
              },
              id: null
            });
            return;
          }

          // Handle the request
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          logger.error("Error handling /mcp POST request:", err);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Internal server error'
              },
              id: null
            });
          }
        }
      });

      // Handle GET requests (SSE streams)
      app.get("/mcp", async (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (!sessionId || !transports[sessionId]) {
          res.status(400).send('Invalid or missing session ID');
          return;
        }

        const lastEventId = req.headers['last-event-id'];
        if (lastEventId) {
          logger.info(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
        } else {
          logger.info(`Establishing new SSE stream for session ${sessionId}`);
        }

        try {
          const transport = transports[sessionId];
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error("Error handling /mcp GET request:", err);
          if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
          }
        }
      });

      // Handle DELETE requests (session termination)
      app.delete("/mcp", async (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (!sessionId || !transports[sessionId]) {
          res.status(400).send('Invalid or missing session ID');
          return;
        }

        logger.info(`Received session termination request for session ${sessionId}`);

        try {
          const transport = transports[sessionId];
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error("Error handling session termination:", err);
          if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
          }
        }
      });

      app.listen(PORT, "0.0.0.0", () => {
        logger.info(`MCP HTTP server listening on :${PORT}`);
        logger.info(`Streamable HTTP endpoint: /mcp (GET + POST + DELETE)`);
        resolve();
      });

      // Handle server shutdown
      process.on('SIGINT', async () => {
        logger.info('Shutting down server...');
        for (const sessionId in transports) {
          try {
            logger.info(`Closing transport for session ${sessionId}`);
            await transports[sessionId].close();
            delete transports[sessionId];
          } catch (error) {
            logger.error(`Error closing transport for session ${sessionId}:`, error);
          }
        }
        logger.info('Server shutdown complete');
        process.exit(0);
      });

    } catch (error) {
      reject(error);
    }
  });
}