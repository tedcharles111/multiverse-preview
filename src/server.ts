import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import previewRoutes from './routes/previewRoutes';
import { sessionStore } from './sessionStore';

const app = express();

// Allowed origins
const allowedOrigins = ['https://themultiverse.build', 'http://localhost:3000'];

// Manual CORS middleware – runs before everything, sets headers even on errors
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight immediately
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Also use the cors package as a backup
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '50mb' }));

// Serve a simple favicon to avoid 404s
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/preview', previewRoutes);

// Proxy route for serving preview content
app.use('/preview/:sessionId', (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).send('Preview session not found');
  }

  // Check if the child process is still alive (optional, but helps debugging)
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
    // Increase timeout for slow servers
    proxyTimeout: 30000,
    timeout: 30000,
  } as any);

  return proxy(req, res, next);
});

// Global error handler – CORS headers already set by manual middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));
