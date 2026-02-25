import { Router } from 'express';
import { ContainerManager } from '../containerManager';
import { sessionStore } from '../sessionStore';
import { streamLogs } from '../logStreamer';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const containerManager = new ContainerManager();

router.post('/create', async (req, res) => {
  try {
    const { files, startCommand } = req.body;
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'files object required' });
    }

    const sessionId = uuidv4().slice(0, 8);
    const session = await containerManager.createContainer(sessionId, files, startCommand);

    // For Codespaces, we return the port; the user can forward it manually
    const previewUrl = `http://localhost:${session.hostPort}`;

    res.json({ sessionId, previewUrl });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await containerManager.stopContainer(sessionId);
  res.json({ success: true });
});

router.get('/logs/:sessionId', (req, res) => {
  streamLogs(req.params.sessionId, res);
});

router.get('/status/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: session.status, lastAccessed: session.lastAccessed });
});

export default router;
