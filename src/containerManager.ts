import { v4 as uuidv4 } from 'uuid';
import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { sessionStore } from './sessionStore';
import { PreviewSession } from './types/previewSession';

const BASE_DIR = '/tmp/previews';

export class ContainerManager {
  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
    const workDir = path.join(BASE_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    await this.runCommand('npm install', workDir);

    const containerPort = this.detectDevPort(files);
    const cmd = startCommand || this.detectStartCommand(files);

    const env = { ...process.env, PORT: containerPort.toString() };
    const serverProcess = spawn('sh', ['-c', cmd], { cwd: workDir, env, stdio: 'pipe' });

    serverProcess.stdout.on('data', (data) => console.log(`[${sessionId}] stdout: ${data}`));
    serverProcess.stderr.on('data', (data) => console.error(`[${sessionId}] stderr: ${data}`));

    const hostPort = await this.waitForPort(containerPort);

    const session: PreviewSession = {
      id: sessionId,
      containerId: sessionId,
      hostPort,
      containerPort,
      subdomain: sessionId,
      createdAt: new Date(),
      lastAccessed: new Date(),
      status: 'running',
    };
    sessionStore.set(sessionId, session);
    (session as any).process = serverProcess;

    return session;
  }

  private async runCommand(command: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private detectDevPort(files: Record<string, string>): number {
    if (files['vite.config.js'] || files['vite.config.ts']) return 5173;
    if (files['next.config.js'] || files['next.config.ts']) return 3000;
    return 3000;
  }

  private detectStartCommand(files: Record<string, string>): string {
    if (files['package.json']) {
      try {
        const pkg = JSON.parse(files['package.json']);
        if (pkg.scripts?.dev) return 'npm run dev';
        if (pkg.scripts?.start) return 'npm start';
      } catch {}
    }
    return 'npm run dev';
  }

  private async waitForPort(port: number, timeout = 10000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, 'localhost');
          socket.on('connect', () => { socket.destroy(); resolve(true); });
          socket.on('error', reject);
        });
        return port;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
  }

  async stopContainer(sessionId: string) {
    const session = sessionStore.get(sessionId);
    if (!session) return;
    const proc = (session as any).process;
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGTERM');
    }
    await fs.rm(path.join(BASE_DIR, sessionId), { recursive: true, force: true });
    sessionStore.delete(sessionId);
  }
}
