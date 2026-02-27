import { Router } from 'express';
import { ContainerManager } from '../containerManager';
import { sessionStore } from '../sessionStore';
import { streamLogs } from '../logStreamer';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const cm = new ContainerManager();

router.post('/create', async (req, res) => {
  try {
    const { files, startCommand } = req.body;
    if (!files) return res.status(400).json({ error: 'files required' });

    const sessionId = uuidv4().slice(0, 8);
    const session = await cm.createContainer(sessionId, files, startCommand);

    res.json({ 
      sessionId, 
      previewUrl: session.previewUrl 
    });
  } catch (e: any) {
    console.error('Preview creation error:', e);
    // Send clean error message to the client
    res.status(500).json({ error: e.message || 'Unknown error' });
  }
});

router.post('/stop/:id', async (req, res) => {
  try {
    await cm.stopContainer(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs/:id', (req, res) => {
  streamLogs(req.params.id, res).catch(e => {
    console.error('Log error:', e);
    res.status(500).end();
  });
});

router.get('/status/:id', (req, res) => {
  const s = sessionStore.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

export default router;
