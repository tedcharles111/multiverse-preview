import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import previewRoutes from './routes/previewRoutes';
import { sessionStore } from './sessionStore';

const app = express();

// Allowed origins
const allowedOrigins = ['https://themultiverse.build', 'http://localhost:3000'];

// Manual CORS middleware – sets headers for every response
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests immediately
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Also use the cors package as a backup (optional)
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '50mb' }));

app.use('/preview', previewRoutes);

app.use('/preview/:sessionId', (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).send('Preview session not found');
  }

  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${session.hostPort}`,
    changeOrigin: true,
    pathRewrite: { [`^/preview/${sessionId}`]: '' },
    ws: true,
    onError: (err: Error, req: IncomingMessage, res: ServerResponse) => {
      console.error(`Proxy error for session ${sessionId}:`, err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end('Preview server error: ' + err.message);
      }
    },
  } as any);

  return proxy(req, res, next);
});

// Global error handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));
