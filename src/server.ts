import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import previewRoutes from './routes/previewRoutes';
import { sessionStore } from './sessionStore';

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/preview', previewRoutes);

app.use('/preview/:sessionId', async (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).send('Preview session not found');
  }

  const proxy = createProxyMiddleware({
    target: `http://localhost:${session.hostPort}`,
    changeOrigin: true,
    pathRewrite: {
      [`^/preview/${sessionId}`]: '',
    },
    ws: true,
  });

  // Attach error handler manually
  (proxy as any).on('error', (err: Error, req: IncomingMessage, res: ServerResponse) => {
    console.error(`Proxy error for session ${sessionId}:`, err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end('Preview server error');
    }
  });

  return proxy(req, res, next);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));
