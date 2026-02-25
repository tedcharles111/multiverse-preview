export interface PreviewSession {
  id: string;
  containerId: string;
  hostPort: number;
  containerPort: number;
  subdomain: string;
  createdAt: Date;
  lastAccessed: Date;
  status: 'starting' | 'running' | 'stopped' | 'error';
}
