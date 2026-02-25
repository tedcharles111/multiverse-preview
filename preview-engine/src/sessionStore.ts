import { PreviewSession } from './types/previewSession';

class SessionStore {
  private sessions: Map<string, PreviewSession> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  set(session: PreviewSession) {
    this.sessions.set(session.id, session);
    this.resetIdleTimer(session.id);
  }

  get(id: string): PreviewSession | undefined {
    const session = this.sessions.get(id);
    if (session) this.resetIdleTimer(id);
    return session;
  }

  delete(id: string) {
    this.sessions.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private resetIdleTimer(id: string) {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.sessions.delete(id);
    }, 15 * 60 * 1000);
    this.timers.set(id, timer);
  }
}

export const sessionStore = new SessionStore();
