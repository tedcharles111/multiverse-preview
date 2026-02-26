import { v4 as uuidv4 } from 'uuid';
import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { sessionStore } from './sessionStore';
import { PreviewSession } from './types/previewSession';

const BASE_DIR = '/tmp/previews';
// 🔥 HARDCODED DOMAIN – replace with your actual domain
const PUBLIC_URL = 'https://multiverse-preview.pxxl.click';

export class ContainerManager {
  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
    const workDir = path.join(BASE_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    const hasPackageJson = files['package.json'] !== undefined;
    if (hasPackageJson) {
      try {
        await this.runCommand('npm install', workDir);
      } catch (err) {
        console.error(`[${sessionId}] npm install failed:`, err);
      }
    } else {
      console.log(`[${sessionId}] No package.json, skipping npm install`);
    }

    const hostPort = await this.findFreePort(3001, 3999);
    const env = { ...process.env, PORT: hostPort.toString() };
    const cmd = startCommand || this.detectStartCommand(files);

    const serverProcess = spawn('sh', ['-c', cmd], { cwd: workDir, env, stdio: 'pipe' });

    let stderrLog = '';
    serverProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrLog += msg;
      console.error(`[${sessionId}] stderr: ${msg}`);
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[${sessionId}] stdout: ${data.toString()}`);
    });

    try {
      await this.waitForPort(hostPort, serverProcess, 10000);
    } catch (err) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`Process exited with code ${serverProcess.exitCode}. Stderr: ${stderrLog}`);
      }
      throw err;
    }

    const session: PreviewSession = {
      id: sessionId,
      containerId: sessionId,
      hostPort,
      containerPort: this.detectDevPort(files),
      subdomain: sessionId,
      createdAt: new Date(),
      lastAccessed: new Date(),
      status: 'running',
      previewUrl: `${PUBLIC_URL}/preview/${sessionId}`,
    };
    sessionStore.set(sessionId, session);
    (session as any).process = serverProcess;

    return session;
  }

  private async findFreePort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, 'localhost');
          socket.on('connect', () => {
            socket.destroy();
            reject(new Error('Port in use'));
          });
          socket.on('error', (err) => {
            if ((err as any).code === 'ECONNREFUSED') {
              resolve(true);
            } else {
              reject(err);
            }
          });
        });
        return port;
      } catch {}
    }
    throw new Error('No free port found');
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
    if (files['server.js']) return 'node server.js';
    return 'npm run dev';
  }

  private async waitForPort(port: number, process: any, timeout = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (process.exitCode !== null) {
        throw new Error(`Process exited with code ${process.exitCode}`);
      }
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, 'localhost');
          socket.on('connect', () => { socket.destroy(); resolve(true); });
          socket.on('error', reject);
        });
        return;
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
