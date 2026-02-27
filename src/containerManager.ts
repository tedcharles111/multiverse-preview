import { v4 as uuidv4 } from 'uuid';
import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { sessionStore } from './sessionStore';
import { PreviewSession } from './types/previewSession';

const BASE_DIR = '/tmp/previews';
// Hardcoded domain – works around env var issues
const PUBLIC_URL = 'https://multiverse-preview.pxxl.click';

export class ContainerManager {
  private static activePreviews = 0;
  private static MAX_CONCURRENT = 15; // adjust based on your server capacity

  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
    // Enforce concurrency limit
    if (ContainerManager.activePreviews >= ContainerManager.MAX_CONCURRENT) {
      throw new Error(`Server busy (${ContainerManager.MAX_CONCURRENT} concurrent previews). Please try again later.`);
    }
    ContainerManager.activePreviews++;

    const workDir = path.join(BASE_DIR, sessionId);
    try {
      await fs.mkdir(workDir, { recursive: true });

      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(workDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      }

      // Only run npm install if package.json exists
      const hasPackageJson = files['package.json'] !== undefined;
      if (hasPackageJson) {
        try {
          await this.runCommand('npm install', workDir);
        } catch (err) {
          // Log but continue – maybe it's a project without dependencies
          console.error(`[${sessionId}] npm install failed:`, err);
        }
      } else {
        console.log(`[${sessionId}] No package.json, skipping npm install`);
      }

      // Find a free port (3001-3999)
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

      // Wait for the assigned port to be listening, or process to exit
      try {
        await this.waitForPort(hostPort, serverProcess, 15000); // increased timeout
      } catch (err) {
        // Process might have died – capture its exit code and stderr
        if (serverProcess.exitCode !== null) {
          throw new Error(`Process exited with code ${serverProcess.exitCode}. Stderr: ${stderrLog || '(no stderr)'}`);
        }
        throw new Error(`Server did not start on port ${hostPort} within timeout. Stderr: ${stderrLog || '(none)'}`);
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
    } finally {
      // Decrement counter no matter what
      ContainerManager.activePreviews--;
    }
  }

  private async findFreePort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1');
          socket.on('connect', () => {
            socket.destroy();
            reject(new Error('Port in use'));
          });
          socket.on('error', (err) => {
            if ((err as any).code === 'ECONNREFUSED') {
              resolve(true); // port is free
            } else {
              reject(err);
            }
          });
        });
        return port; // found free port
      } catch {
        // try next port
      }
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

  private async waitForPort(port: number, process: any, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (process.exitCode !== null) {
        throw new Error(`Process exited early with code ${process.exitCode}`);
      }
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1');
          socket.on('connect', () => { socket.destroy(); resolve(true); });
          socket.on('error', reject);
        });
        return; // port is listening
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
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
