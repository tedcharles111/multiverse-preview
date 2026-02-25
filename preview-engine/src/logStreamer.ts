import { Response } from 'express';
import Docker from 'dockerode';
import { sessionStore } from './sessionStore';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export async function streamLogs(sessionId: string, res: Response) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  const container = docker.getContainer(session.containerId);
  const logsStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: false,
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  logsStream.on('data', (chunk) => {
    const output = chunk.toString('utf8').substring(8);
    res.write(`data: ${JSON.stringify({ log: output })}\n\n`);
  });

  logsStream.on('end', () => {
    res.write('event: end\ndata: \n\n');
    res.end();
  });

  res.on('close', () => {
    logsStream.destroy();
  });
}
