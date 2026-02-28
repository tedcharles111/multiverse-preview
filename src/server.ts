import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import previewRoutes from './routes/previewRoutes';
import { sessionStore } from './sessionStore';

const app = express();

// CORS configuration
const corsOptions = {
  origin: ['https://themultiverse.build', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Apply CORS middleware to all routes
app.use(cors(corsOptions));

// Explicitly handle preflight requests for all routes
app.options('*', cors(corsOptions));

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
