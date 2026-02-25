import { Response } from 'express';
import { sessionStore } from './sessionStore';

export async function streamLogs(sessionId: string, res: Response) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  // Get the process from the session (stored in containerManager)
  const proc = (session as any).process;
  if (!proc || !proc.stdout || !proc.stderr) {
    res.status(500).send('Process not available for logging');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendLog = (type: string, data: Buffer) => {
    const output = data.toString('utf8');
    res.write(`data: ${JSON.stringify({ type, log: output })}\n\n`);
  };

  const onStdout = (data: Buffer) => sendLog('stdout', data);
  const onStderr = (data: Buffer) => sendLog('stderr', data);

  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);

  res.on('close', () => {
    proc.stdout.off('data', onStdout);
    proc.stderr.off('data', onStderr);
    res.end();
  });
}
