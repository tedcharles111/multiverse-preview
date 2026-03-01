import { v4 as uuidv4 } from 'uuid';
import { exec, spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { sessionStore } from './sessionStore';
import { PreviewSession } from './types/previewSession';

const BASE_DIR = '/tmp/previews';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://multiverse-preview.onrender.com';
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

interface ManagedProcess {
  process: ChildProcess;
  restartCount: number;
  lastRestart: number;
  stdout: string;
  stderr: string;
}

export class ContainerManager {
  private static activePreviews = 0;
  private static MAX_CONCURRENT = 50;
  private static timeouts: Map<string, NodeJS.Timeout> = new Map();
  private static processes: Map<string, ManagedProcess> = new Map();
  private static readonly MAX_RESTARTS = 5; // Increased to allow time for installation
  private static readonly RESTART_BACKOFF = 3000; // 3 seconds base

  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
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

      // Basic package.json repair
      if (files['package.json']) {
        try {
          const pkg = JSON.parse(files['package.json']);
          await fs.writeFile(path.join(workDir, 'package.json'), JSON.stringify(pkg, null, 2));
        } catch (e) {
          console.warn(`[${sessionId}] package.json is malformed, but continuing:`, e);
        }
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

      let cmd = startCommand || this.buildStartCommand(files, hostPort);

      // Start the process with monitoring
      const managed = await this.startMonitoredProcess(sessionId, cmd, workDir, env, hostPort, files);

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
      ContainerManager.processes.set(sessionId, managed);

      this.setIdleTimeout(sessionId);

      return session;
    } finally {
      ContainerManager.activePreviews--;
    }
  }

  private async startMonitoredProcess(
    sessionId: string,
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    port: number,
    files: Record<string, string>
  ): Promise<ManagedProcess> {
    const managed: ManagedProcess = {
      process: null!,
      restartCount: 0,
      lastRestart: Date.now(),
      stdout: '',
      stderr: ''
    };

    const start = async () => {
      const proc = spawn('sh', ['-c', command], { cwd, env, stdio: 'pipe' });
      managed.process = proc;

      let stderrBuffer = '';
      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        managed.stderr += chunk;
        console.error(`[${sessionId}] stderr: ${chunk}`);
      });

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        managed.stdout += chunk;
        console.log(`[${sessionId}] stdout: ${chunk}`);
      });

      proc.on('exit', async (code, signal) => {
        console.log(`[${sessionId}] process exited with code ${code} signal ${signal}`);

        // Check for missing Vite error
        const isViteMissing = stderrBuffer.includes('Cannot find package') && stderrBuffer.includes('vite');
        const isViteNotFound = stderrBuffer.includes('vite: not found');

        if ((isViteMissing || isViteNotFound) && managed.restartCount < ContainerManager.MAX_RESTARTS) {
          console.log(`[${sessionId}] Vite missing, attempting to install...`);
          try {
            // Install vite as dev dependency
            await this.runCommand('npm install -D vite', cwd);
            console.log(`[${sessionId}] Vite installed, restarting...`);
          } catch (installErr) {
            console.error(`[${sessionId}] Failed to install Vite:`, installErr);
          }
          // Continue to restart after backoff
        }

        // Attempt restart if within limits and not stopped manually
        if (managed.restartCount < ContainerManager.MAX_RESTARTS) {
          const backoff = ContainerManager.RESTART_BACKOFF * Math.pow(2, managed.restartCount);
          managed.restartCount++;
          managed.lastRestart = Date.now();
          console.log(`[${sessionId}] restarting in ${backoff}ms (attempt ${managed.restartCount})`);
          setTimeout(() => start(), backoff);
        } else {
          console.error(`[${sessionId}] max restarts reached, giving up`);
          const session = sessionStore.get(sessionId);
          if (session) session.status = 'error';
        }
      });

      // Wait for port to be listening (or process to fail)
      this.waitForPort(port, proc, 15000).catch(() => {});
    };

    start();
    // Wait a bit for the first start
    await new Promise(resolve => setTimeout(resolve, 2000));
    return managed;
  }

  async refreshSession(sessionId: string) {
    const session = sessionStore.get(sessionId);
    if (session) {
      session.lastAccessed = new Date();
      this.setIdleTimeout(sessionId);
    }
  }

  private setIdleTimeout(sessionId: string) {
    const existing = ContainerManager.timeouts.get(sessionId);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.stopContainer(sessionId).catch(console.error);
    }, IDLE_TIMEOUT);
    ContainerManager.timeouts.set(sessionId, timeout);
  }

  async getProcessOutput(sessionId: string): Promise<{ stdout: string; stderr: string }> {
    const managed = ContainerManager.processes.get(sessionId);
    if (!managed) return { stdout: '', stderr: '' };
    return { stdout: managed.stdout, stderr: managed.stderr };
  }

  private buildStartCommand(files: Record<string, string>, assignedPort: number): string {
    const isVite = files['vite.config.js'] || files['vite.config.ts'];
    if (isVite) {
      return `npx vite --port ${assignedPort} --host`;
    }

    const isNext = files['next.config.js'] || files['next.config.ts'];
    if (isNext) return 'npm run dev';

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
      exec(command, { cwd }, (error, stdout, stderr) => {
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

  private async waitForPort(port: number, process: ChildProcess, timeout = 15000): Promise<void> {
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
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  async stopContainer(sessionId: string) {
    const session = sessionStore.get(sessionId);
    if (!session) return;
    const managed = ContainerManager.processes.get(sessionId);
    if (managed && managed.process) {
      managed.process.kill('SIGTERM');
    }
    await fs.rm(path.join(BASE_DIR, sessionId), { recursive: true, force: true });
    sessionStore.delete(sessionId);
    ContainerManager.processes.delete(sessionId);
    const timeout = ContainerManager.timeouts.get(sessionId);
    if (timeout) clearTimeout(timeout);
    ContainerManager.timeouts.delete(sessionId);
  }
}
