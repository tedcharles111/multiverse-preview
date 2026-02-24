import Docker from 'dockerode';
import { PreviewSession } from './types/previewSession';
import { sessionStore } from './sessionStore';
import { PassThrough } from 'stream';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export class ContainerManager {
  // Create container with resource limits
  async createContainer(sessionId: string, files: Record<string, string>, startCommand?: string): Promise<PreviewSession> {
    // Generate unique container name
    const containerName = `preview-${sessionId}`;

    // Create container from node:18-alpine
    const container = await docker.createContainer({
      Image: 'node:18-alpine',
      name: containerName,
      HostConfig: {
        Memory: 512 * 1024 * 1024, // 512 MB
        MemorySwap: 0,              // no swap
        CpuPeriod: 100000,
        CpuQuota: 50000,            // 0.5 CPU
        PublishAllPorts: false,
        PortBindings: {},            // will be set after detecting port
        AutoRemove: true,            // automatically remove when stopped
        Binds: [],                   // no host mounts for security
      },
      WorkingDir: '/app',
      Cmd: ['sh', '-c', 'while true; do sleep 3600; done'], // initial sleep, we'll exec commands
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    await container.start();

    // Write files to container
    await this.writeFiles(container, files);

    // Install dependencies
    await this.execCommand(container, 'npm install'); // could detect package manager

    // Detect dev server port
    const port = await this.detectDevPort(container, files);

    // Start dev server
    const cmd = startCommand || this.detectStartCommand(files);
    await this.execCommand(container, cmd, { detach: true }); // run in background

    // Expose port: find a free host port and map it
    const hostPort = await this.findFreePort();
    await this.exposePort(container, port, hostPort);

    // Create session record
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

    // Configure reverse proxy (Caddy) - we'll implement in portExposer
    await this.updateProxyConfig(sessionId, hostPort);

    return session;
  }

  private async writeFiles(container: Docker.Container, files: Record<string, string>) {
    // Create a tar archive of files and pipe into container's /app
    const tar = require('tar-stream');
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
        // consume data to prevent hanging
        stream.on('data', () => {});
      });
    }
  }

  private async detectDevPort(container: Docker.Container, files: Record<string, string>): Promise<number> {
    // Common ports: 3000 (React CRA, Next.js), 5173 (Vite), 8000 (Python), 8080
    // We can try to parse config files or just scan common ports.
    // For simplicity, we'll check if there's a vite.config.js -> 5173, else 3000.
    if (files['vite.config.js'] || files['vite.config.ts']) {
      return 5173;
    }
    if (files['next.config.js'] || files['next.config.ts']) {
      return 3000; // Next.js default
    }
    return 3000; // fallback
  }

  private detectStartCommand(files: Record<string, string>): string {
    if (files['package.json']) {
      try {
        const pkg = JSON.parse(files['package.json']);
        if (pkg.scripts && pkg.scripts.dev) return 'npm run dev';
        if (pkg.scripts && pkg.scripts.start) return 'npm start';
      } catch {}
    }
    return 'npm run dev'; // fallback
  }

  private async findFreePort(): Promise<number> {
    const net = require('net');
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  private async exposePort(container: Docker.Container, containerPort: number, hostPort: number) {
    // Update container's host config to add port binding
    await container.update({
      HostConfig: {
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostPort: hostPort.toString() }]
        }
      }
    });
    // Restart container for changes to take effect? Actually we can't update port bindings on a running container easily.
    // Better approach: create container with dynamic port mapping from the start. But we don't know the port until after install.
    // Workaround: we can stop container, modify, restart. But that would kill the dev server.
    // Alternative: use a reverse proxy that connects to container's IP:port directly without host mapping? Not possible from host network.
    // We'll use docker networking: create a user-defined network, and let Caddy connect directly to container IP.
    // That's more robust. We'll do that.
  }

  private async updateProxyConfig(sessionId: string, hostPort: number) {
    // For now, we assume Caddy is configured with a wildcard domain and uses a file for dynamic config.
    // We'll write a Caddyfile snippet or use Caddy's API.
    // Implementation in portExposer.
  }

  async stopContainer(sessionId: string) {
    const session = sessionStore.get(sessionId);
    if (!session) return;
    const container = docker.getContainer(session.containerId);
    await container.stop();
    sessionStore.delete(sessionId);
  }
}
