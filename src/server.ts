import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import previewRoutes from './routes/previewRoutes';
import { sessionStore } from './sessionStore';
import { ContainerManager } from './containerManager';

const app = express();
const containerManager = new ContainerManager();

const allowedOrigins = ['https://themultiverse.build', 'http://localhost:3000'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '50mb' }));

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/preview', previewRoutes);

app.use('/preview/:sessionId', async (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).send('Preview session not found');
  }

  await containerManager.refreshSession(sessionId);

  const proc = (session as any).process;
  if (proc && proc.exitCode !== null) {
    console.error(`Session ${sessionId} process already exited with code ${proc.exitCode}`);
    return res.status(502).send('Preview server is no longer running');
  }

  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${session.hostPort}`,
    changeOrigin: true,
    pathRewrite: { [`^/preview/${sessionId}`]: '' },
    ws: true,
    onError: (err: Error, req: IncomingMessage, res: ServerResponse) => {
      console.error(`Proxy error for session ${sessionId}:`, err.message);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(`Preview server error: ${err.message}. The preview may have crashed or not started properly.`);
      }
    },
    proxyTimeout: 30000,
    timeout: 30000,
  } as any);

  return proxy(req, res, next);
});

app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));
