import { Response } from 'express';
import Docker from 'dockerode';
const docker = new Docker();

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
    // Docker logs stream includes a 8-byte header, we need to strip it.
    // For simplicity, we'll convert to string and send.
    const output = chunk.toString('utf8').substring(8); // crude strip
    res.write(`data: ${JSON.stringify({ log: output })}\n\n`);
  });

  logsStream.on('end', () => {
    res.write('event: end\ndata: \n\n');
    res.end();
  });

  req.on('close', () => {
    logsStream.destroy();
  });
}
