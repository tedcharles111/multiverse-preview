import { Response } from 'express';
import { sessionStore } from './sessionStore';
import { ContainerManager } from './containerManager';

const containerManager = new ContainerManager();

export async function streamLogs(sessionId: string, res: Response) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  // Get stored logs from the container manager (npm install, etc.)
  const { stdout, stderr } = await containerManager.getProcessOutput(sessionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send all historical stdout
  if (stdout) {
    res.write(`event: history\ndata: ${JSON.stringify({ type: 'stdout', data: stdout })}\n\n`);
  }
  if (stderr) {
    res.write(`event: history\ndata: ${JSON.stringify({ type: 'stderr', data: stderr })}\n\n`);
  }

  // Get the current process (if still alive)
  const managed = (containerManager as any).constructor.processes.get(sessionId);
  if (!managed || !managed.process) {
    res.write(`event: end\ndata: Process terminated\n\n`);
    res.end();
    return;
  }

  // Live streaming
  const stdoutHandler = (data: Buffer) => {
    res.write(`data: ${JSON.stringify({ type: 'stdout', data: data.toString() })}\n\n`);
  };
  const stderrHandler = (data: Buffer) => {
    res.write(`data: ${JSON.stringify({ type: 'stderr', data: data.toString() })}\n\n`);
  };

  managed.process.stdout.on('data', stdoutHandler);
  managed.process.stderr.on('data', stderrHandler);

  res.on('close', () => {
    managed.process.stdout.off('data', stdoutHandler);
    managed.process.stderr.off('data', stderrHandler);
    res.end();
  });
}
