// Local fixture pages served from loopback for real-browser tests and benchmarks.
import { createServer } from "node:http";

const shell = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

const pages = {
  "/login": shell(
    "Login",
    `<h1>Sign in</h1>
     <label>Email <input id="email" type="text" aria-label="Email"></label>
     <button id="go" type="button">Submit</button>
     <p id="out"></p>`,
    `document.getElementById('go').addEventListener('click', () => {
       document.getElementById('out').textContent = 'Welcome ' + document.getElementById('email').value;
     });`,
  ),
  "/large": shell(
    "Large",
    `<main id="m"></main>`,
    `const m = document.getElementById('m');
     const f = document.createDocumentFragment();
     for (let i = 0; i < 5000; i++) { const b = document.createElement('button'); b.textContent = 'Item ' + i; f.appendChild(b); }
     m.appendChild(f);`,
  ),
  "/slow": shell(
    "Slow",
    `<h1>Slow page</h1><p id="s">Loading…</p>`,
    `setTimeout(() => { document.getElementById('s').textContent = 'Loaded'; }, 800);`,
  ),
  "/spa": shell(
    "SPA",
    `<h1>SPA</h1><button id="n" type="button">Next view</button><p id="v">View one</p>`,
    `document.getElementById('n').addEventListener('click', () => {
       history.pushState({}, '', '/spa/two');
       setTimeout(() => { document.getElementById('v').textContent = 'View two'; }, 300);
     });`,
  ),
};

export async function startFixtureServer() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = pages[path] ?? (path.startsWith("/spa") ? pages["/spa"] : undefined);
    if (!html) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
