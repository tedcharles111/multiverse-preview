import Docker from 'dockerode';
import { PreviewSession } from './types/previewSession';
import { sessionStore } from './sessionStore';
import * as tar from 'tar-stream';
import net from 'net';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export class ContainerManager {
  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
    const containerName = `preview-${sessionId}`;

    const container = await docker.createContainer({
      Image: 'node:18-alpine',
      name: containerName,
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        MemorySwap: 0,
        CpuPeriod: 100000,
        CpuQuota: 50000,
        PublishAllPorts: true,
        AutoRemove: true,
      },
      WorkingDir: '/app',
      Cmd: ['sh', '-c', 'while true; do sleep 3600; done'],
      OpenStdin: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    await container.start();

    // Write files
    await this.writeFiles(container, files);

    // Install deps
    await this.execCommand(container, 'npm install');

    // Detect port
    const port = await this.detectDevPort(files);

    // Start dev server
    const cmd = startCommand || this.detectStartCommand(files);
    await this.execCommand(container, cmd, { detach: true });

    // Get the dynamically mapped host port
    const hostPort = await this.getHostPort(container, port);

    const session: PreviewSession = {
      id: sessionId,
      containerId: container.id,
      hostPort,
      containerPort: port,
      subdomain: sessionId,
      createdAt: new Date(),
      lastAccessed: new Date(),
      status: 'running',
    };
    sessionStore.set(session);

    return session;
  }

  private async writeFiles(container: Docker.Container, files: Record<string, string>) {
    const pack = tar.pack();
    for (const [filePath, content] of Object.entries(files)) {
      pack.entry({ name: filePath }, content);
    }
    pack.finalize();
    await container.putArchive(pack, { path: '/app' });
  }

  private async execCommand(container: Docker.Container, command: string, options?: { detach?: boolean }): Promise<void> {
    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Detach: options?.detach || false,
    });

    if (options?.detach) {
      await exec.start({ Detach: true });
    } else {
      const stream = await exec.start({ Detach: false });
      return new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
        stream.on('data', () => {});
      });
    }
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

  private async getHostPort(container: Docker.Container, containerPort: number): Promise<number> {
    const data = await container.inspect();
    const bindings = data.NetworkSettings.Ports[`${containerPort}/tcp`];
    if (bindings && bindings.length > 0) {
      return parseInt(bindings[0].HostPort);
    }
    throw new Error(`Port ${containerPort} not mapped`);
  }

  async stopContainer(sessionId: string) {
    const session = sessionStore.get(sessionId);
    if (!session) return;
    const container = docker.getContainer(session.containerId);
    await container.stop();
    sessionStore.delete(sessionId);
  }
}
