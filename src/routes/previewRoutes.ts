import { Router } from 'express';
import { ContainerManager } from '../containerManager';
import { sessionStore } from '../sessionStore';
import { streamLogs } from '../logStreamer';
import { v4 as uuidv4 } from 'uuid';
import { addRoute, removeRoute } from '../portExposer';

const router = Router();
const containerManager = new ContainerManager();

// POST /preview/create
router.post('/create', async (req, res) => {
  try {
    const { files, startCommand } = req.body; // files: Record<string, string>
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'files object required' });
    }

    const sessionId = uuidv4().slice(0, 8); // short id
    const session = await containerManager.createContainer(sessionId, files, startCommand);
    const previewUrl = `https://${session.subdomain}.preview.domain.com`;

    res.json({ sessionId, previewUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /preview/restart/:sessionId
router.post('/restart/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Re-run dev server command (we need to store the command)
  // For simplicity, we'll stop and start a new container with same files.
  // But we need to preserve files. This is complex; we'll implement later.
  res.status(501).json({ error: 'Not implemented' });
});

// POST /preview/stop/:sessionId
router.post('/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await containerManager.stopContainer(sessionId);
  await removeRoute(sessionId);
  res.json({ success: true });
});

// GET /preview/logs/:sessionId
router.get('/logs/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  streamLogs(sessionId, res);
});

// GET /preview/status/:sessionId
router.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: session.status, lastAccessed: session.lastAccessed });
});

export default router;
