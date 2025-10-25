import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PORT } from "../config/server-config.js";
import { randomUUID } from "node:crypto";
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
      let transport: SSEServerTransport | null = null;

      app.use(cors());  
      app.use(express.json());

      app.get("/sse", (req, res) => {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Access-Control-Allow-Origin", "*");
        
        transport = new SSEServerTransport("/messages", res);
        
        res.on("close", () => {
          logger.info("SSE connection closed");
          transport = null;
        });
        
        server.connect(transport).catch(error => {
          logger.error("Error connecting SSE transport:", error);
          // reject(error);
        });
      });

      app.options("/messages", cors());
      app.post("/messages", cors(), (req, res) => {
        if (transport) {
          transport.handlePostMessage(req, res);
        } else {
          res.status(400).send('No active SSE connection found');
        }
      });

      app.post("/mcp", async (req, res) => {
        try {
          const transport = new StreamableHTTPServerTransport({ 
            enableJsonResponse: true, 
            sessionIdGenerator: () => randomUUID(), 
          });
          res.on("close", () => transport.close());
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          logger.error("Error handling /mcp request:", err);
          if (!res.headersSent) res.status(500).send("MCP server error");
        }
      });

      app.get('/', (_, res) => {
        res.send('Open Food Facts MCP Server is running');
      });

      app.get('/healthz', (_req, res) => res.status(200).send('ok'));

      app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Open Food Facts MCP Server running on HTTP port ${PORT}`);
        logger.info(`Use SSE endpoint at http://localhost:${PORT}/sse`);
        logger.info(`Client-to-server messages should be POSTed to http://localhost:${PORT}/messages`);
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}