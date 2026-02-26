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

    // ✅ Return the public previewUrl from the session
    res.json({ 
      sessionId, 
      previewUrl: session.previewUrl 
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stop/:id', async (req, res) => {
  await cm.stopContainer(req.params.id);
  res.json({ success: true });
});

router.get('/logs/:id', (req, res) => streamLogs(req.params.id, res));

router.get('/status/:id', (req, res) => {
  const s = sessionStore.get(req.params.id);
  res.json(s || { error: 'not found' });
});

export default router;
