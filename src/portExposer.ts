import axios from 'axios';

const CADDY_API = 'http://localhost:2019/config/';
const DOMAIN = 'preview.domain.com'; // change to your domain

export async function addRoute(sessionId: string, targetPort: number) {
  // Caddy v2 config structure: we need to add a new route to the existing server.
  // This assumes a server block listening on :443 with a wildcard cert.
  // We'll fetch current config, modify, and put back.
  const config = await axios.get(CADDY_API).then(res => res.data);
  const server = config.apps.http.servers.srv0; // adjust if needed
  if (!server.routes) server.routes = [];

  // Add route for subdomain
  server.routes.push({
    match: [{ host: [`${sessionId}.${DOMAIN}`] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `localhost:${targetPort}` }]
    }],
    terminal: true
  });

  await axios.post(CADDY_API, config);
}

export async function removeRoute(sessionId: string) {
  const config = await axios.get(CADDY_API).then(res => res.data);
  const server = config.apps.http.servers.srv0;
  if (server.routes) {
    server.routes = server.routes.filter((r: any) => {
      const match = r.match?.[0]?.host?.[0];
      return match !== `${sessionId}.${DOMAIN}`;
    });
    await axios.post(CADDY_API, config);
  }
}
