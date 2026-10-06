// Standalone, loopback-only mockup server. No Session Host, auth, or API access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/mockup.css', ['mockup.css', 'text/css']],
  ['/mockup.js', ['mockup.js', 'text/javascript']],
  ['/icons.svg', ['icons.svg', 'image/svg+xml']],
]);
const font = process.env.MOCKUP_FONT_FILE ?? fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url));
const port = Number(process.env.MOCKUP_PORT ?? 4391);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/inter.woff2') {
      res.setHeader('Content-Type', 'font/woff2');
      res.end(await readFile(font));
      return;
    }
    const entry = files.get(path);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', `${entry[1]}; charset=utf-8`);
    res.end(await readFile(new URL(entry[0], import.meta.url)));
  } catch (error) {
    console.error(error.message);
    res.writeHead(500);
    res.end('Could not load mockup asset. Run npm ci for the Inter font.');
  }
}).listen(port, '127.0.0.1', () => console.log(`NAT-91 mockups: http://127.0.0.1:${port}`));
