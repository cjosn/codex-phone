import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const port = Number(process.env.GRADLE_PROXY_PORT || 18765);
const cacheRoot = process.env.GRADLE_PROXY_CACHE || path.resolve('codex-go/tooling/sdk/gradle-cache/caches/modules-2/files-2.1');
const groups = ['org/jetbrains/kotlin', 'org/jetbrains/kotlinx', 'com/android/tools/build', 'com/android/tools', 'org/gradle', 'com/android', 'com/google', 'androidx'];
const hosts = [
  'https://dl.google.com/dl/android/maven2/',
  'https://repo.maven.apache.org/maven2/',
  'https://plugins.gradle.org/m2/',
  'https://storage.googleapis.com/r8-releases/raw/',
];
const upstreamAgents = new Map(hosts.map(base => [new URL(base).host, new https.Agent({ keepAlive: true })]));
const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const rawPath = (req.url || '/').split('?')[0];
  let requestPath;
  try { requestPath = decodeURIComponent(rawPath).replace(/^\/+/, ''); } catch { res.writeHead(400).end('invalid path'); return; }
  if (!requestPath || requestPath.split('/').some(part => part === '..' || part === '.')) { res.writeHead(400).end('invalid path'); return; }
  const artifactPath = groups.find(group => requestPath.startsWith(group + '/')) && requestPath.endsWith('.jar');
  if (artifactPath) {
    const parts = requestPath.split('/');
    const group = parts.slice(0, parts.length - 3).join('.');
    const artifact = parts[parts.length - 3];
    const version = parts[parts.length - 2];
    const filename = parts[parts.length - 1];
    const versionDir = path.resolve(cacheRoot, group, artifact, version);
    if (fs.existsSync(versionDir)) {
      const jarPath = fs.readdirSync(versionDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(versionDir, entry.name, filename))
        .find(candidate => fs.existsSync(candidate));
      if (jarPath) {
        const stat = fs.statSync(jarPath);
        res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': stat.size });
        if (req.method === 'HEAD') res.end();
        else {
          const stream = fs.createReadStream(jarPath);
          stream.on('error', error => { if (!res.destroyed) res.destroy(error); });
          stream.pipe(res);
        }
        console.log(`cache ${filename} ${stat.size}`);
        return;
      }
    }
  }
  let index = 0;
  const requestUrl = (url, redirects = 0) => {
    if (!['https:'].includes(url.protocol)) { res.writeHead(502).end('HTTPS upstream required'); return; }
    const request = https.request(url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        'user-agent': 'workspace-gradle-maven-proxy/1.0',
        accept: req.headers.accept || '*/*',
        ...(req.headers.range ? { range: req.headers.range } : {}),
        connection: 'close',
      },
      agent: upstreamAgents.get(url.host),
    }, upstream => {
      if (upstream.statusCode === 404 && index < hosts.length) { upstream.resume(); attempt(); return; }
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location && redirects < 5) {
        const next = new URL(upstream.headers.location, url);
        upstream.resume();
        requestUrl(next, redirects + 1);
        return;
      }
      const headers = {};
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'content-encoding'])
        if (upstream.headers[key] !== undefined) headers[key] = upstream.headers[key];
      res.writeHead(upstream.statusCode || 502, headers);
      if (req.method === 'HEAD') { upstream.resume(); res.end(); }
      else {
        upstream.on('data', chunk => { if (!res.destroyed) res.write(chunk); });
        upstream.on('end', () => { if (!res.destroyed) res.end(); });
        upstream.on('error', error => { if (!res.destroyed) res.destroy(error); });
      }
    });
    request.setTimeout(120000, () => request.destroy(new Error('HTTPS upstream timed out')));
    request.on('error', error => {
      if (res.destroyed) return;
      if (!res.headersSent && index < hosts.length) attempt();
      else if (!res.headersSent) res.writeHead(502).end(error.message);
      else res.destroy(error);
    });
    request.end();
  };
  const attempt = () => {
    if (index >= hosts.length) { res.writeHead(404).end('not found'); return; }
    requestUrl(new URL(requestPath, hosts[index++]));
  };
  attempt();
});
server.on('connect', (req, client, head) => {
  const [hostname, portText] = (req.url || '').split(':');
  const port = Number(portText || 443);
  const allowedHosts = new Set(['dl.google.com', 'www.googleapis.com', 'maven.google.com']);
  if (!allowedHosts.has(hostname) || port !== 443) {
    client.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');
    return;
  }
  const socket = net.connect(port, hostname);
  const timer = setTimeout(() => socket.destroy(new Error('CONNECT timeout')), 30000);
  socket.once('connect', () => {
    clearTimeout(timer);
    client.write('HTTP/1.1 200 Connection Established\\r\\nProxy-agent: workspace-gradle-maven-proxy\\r\\n\\r\\n');
    if (head?.length) socket.write(head);
    client.pipe(socket);
    socket.pipe(client);
    client.on('error', () => socket.destroy());
    socket.on('error', () => client.destroy());
  });
  socket.on('error', () => { clearTimeout(timer); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\n\\r\\n'); });
});
server.listen(port, '127.0.0.1', () => console.log(`Gradle Maven proxy listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
