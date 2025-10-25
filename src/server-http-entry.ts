import express, { Request, Response } from 'express';
import { startServer } from './server.js';

const port = Number(process.env.PORT) || 3000;

(async () => {
  const server = await startServer(false);
  const app = (server as any).expressApp ?? express();

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`MCP HTTP server listening on :${port}`);
  });
})();
