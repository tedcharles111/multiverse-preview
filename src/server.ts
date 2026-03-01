import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
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

// Helper to check if a port is listening
async function isPortListening(port: number, timeout = 2000): Promise<boolean> {
  const socket = new net.Socket();
  return new Promise((resolve) => {
    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

app.use('/preview/:sessionId', async (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).send('Preview session not found');
  }

  await containerManager.refreshSession(sessionId);

  // If session status is error, show crash page
  if (session.status === 'error') {
    const { stderr } = await containerManager.getProcessOutput(sessionId);
    const errorHtml = `
      <!DOCTYPE html>
      <html>
      <head><style>
        body { font-family: system-ui; background: #0a0a0a; color: #f0f0f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .error-container { max-width: 800px; background: #1e1e1e; border-radius: 12px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
        h1 { color: #ff5f5f; font-size: 24px; margin-top: 0; }
        pre { background: #2d2d2d; padding: 16px; border-radius: 8px; overflow-x: auto; color: #e6e6e6; font-size: 14px; border-left: 4px solid #ff5f5f; }
        .info { color: #888; font-size: 14px; margin-top: 16px; }
      </style></head>
      <body>
        <div class="error-container">
          <h1>⚡ Preview Server Crashed</h1>
          <pre>${stderr.replace(/</g, '&lt;').replace(/>/g, '&gt;') || 'No error output captured.'}</pre>
          <div class="info">The preview server exited unexpectedly. This is likely due to an error in your code or missing dependencies.</div>
        </div>
      </body>
      </html>
    `;
    return res.status(500).send(errorHtml);
  }

  // Check if the port is actually listening
  const isAlive = await isPortListening(session.hostPort);
  if (!isAlive) {
    const { stderr } = await containerManager.getProcessOutput(sessionId);
    const errorHtml = `
      <!DOCTYPE html>
      <html>
      <head><style>
        body { font-family: system-ui; background: #0a0a0a; color: #f0f0f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .error-container { max-width: 800px; background: #1e1e1e; border-radius: 12px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
        h1 { color: #ff5f5f; font-size: 24px; margin-top: 0; }
        pre { background: #2d2d2d; padding: 16px; border-radius: 8px; overflow-x: auto; color: #e6e6e6; font-size: 14px; border-left: 4px solid #ff5f5f; }
        .info { color: #888; font-size: 14px; margin-top: 16px; }
      </style></head>
      <body>
        <div class="error-container">
          <h1>⚡ Preview Server Not Responding</h1>
          <pre>${stderr.replace(/</g, '&lt;').replace(/>/g, '&gt;') || 'The server did not start properly.'}</pre>
          <div class="info">The preview server is not responding. This could be a temporary issue or an error in your code.</div>
        </div>
      </body>
      </html>
    `;
    return res.status(502).send(errorHtml);
  }

  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${session.hostPort}`,
    changeOrigin: true,
    pathRewrite: { [`^/preview/${sessionId}`]: '' },
    ws: true,
    onError: async (err: Error, req: IncomingMessage, res: ServerResponse) => {
      console.error(`Proxy error for session ${sessionId}:`, err.message);
      if (!res.headersSent) {
        const { stderr } = await containerManager.getProcessOutput(sessionId);
        const errorHtml = `
          <!DOCTYPE html>
          <html>
          <head><style>
            body { font-family: system-ui; background: #0a0a0a; color: #f0f0f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .error-container { max-width: 800px; background: #1e1e1e; border-radius: 12px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
            h1 { color: #ff5f5f; font-size: 24px; margin-top: 0; }
            pre { background: #2d2d2d; padding: 16px; border-radius: 8px; overflow-x: auto; color: #e6e6e6; font-size: 14px; border-left: 4px solid #ff5f5f; }
            .info { color: #888; font-size: 14px; margin-top: 16px; }
          </style></head>
          <body>
            <div class="error-container">
              <h1>⚡ Preview Server Error</h1>
              <pre>${stderr.replace(/</g, '&lt;').replace(/>/g, '&gt;') || err.message}</pre>
              <div class="info">The preview server could not be reached. This may be a temporary issue or an error in your code.</div>
            </div>
          </body>
          </html>
        `;
        res.statusCode = 502;
        res.end(errorHtml);
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
