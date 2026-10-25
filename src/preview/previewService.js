// Live Preview: serves a generated product on its own local port.
//
// Kept separate from the dashboard and the orchestrator: it is its own HTTP
// server (own port, so the product runs on a different origin than the
// dashboard), it only reads product files, and it knows nothing about
// workflows beyond "which product folder is being previewed".
//
// Only one preview server exists at a time. Starting a preview for another
// workflow switches the server to that product; starting the same one again
// reuses it. "running" is reported only after the product's entry page has
// actually been fetched successfully from the server.

import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { resolveInside } from '../actions/writeFile.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

export const PREVIEW_STATUS = { notStarted: 'not_started', starting: 'starting', running: 'running', error: 'error' };

/** A problem that should be shown to the user as-is. */
export class PreviewError extends Error {}

export class PreviewService extends EventEmitter {
  /**
   * @param {object} options
   * @param {(workflowId: string) => Promise<{ dir: string, entry: string, title: string }>} options.resolveProduct
   *        finds the product folder and entry page; throws PreviewError when unavailable
   * @param {string} [options.host]
   * @param {number} [options.port]  0 picks a free port
   * @param {number} [options.checkTimeoutMs]
   */
  constructor({ resolveProduct, host = '127.0.0.1', port = 0, checkTimeoutMs = 5000 }) {
    super();
    this.resolveProduct = resolveProduct;
    this.host = host;
    this.port = port;
    this.checkTimeoutMs = checkTimeoutMs;
    this.server = null;
    this.product = null;
    this.pending = null;
    this.state = { status: PREVIEW_STATUS.notStarted, workflowId: null, url: null, entry: null, title: null, error: null, startedAt: null, checkedAt: null };
  }

  status() {
    return { ...this.state, port: this.server?.address()?.port ?? null };
  }

  /**
   * Starts (or switches to, or reuses) the preview of a workflow's product.
   * Concurrent calls share one start, so no duplicate servers are created.
   */
  async start(workflowId) {
    if (this.pending) {
      if (this.pending.workflowId === workflowId) return this.pending.promise;
      await this.pending.promise.catch(() => {});
    }
    if (this.state.status === PREVIEW_STATUS.running && this.state.workflowId === workflowId) return this.refresh();

    const promise = this.#start(workflowId);
    this.pending = { workflowId, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) this.pending = null;
    }
  }

  /** Re-checks the current product (e.g. after files changed or to recover from an error). */
  async refresh() {
    if (!this.state.workflowId) return this.status();
    if (this.state.status === PREVIEW_STATUS.error || !this.product) return this.start(this.state.workflowId);
    const result = await this.#check(this.state.url);
    if (!result.ok) {
      return this.#set({ status: PREVIEW_STATUS.error, error: `The preview is no longer accessible: ${this.state.entry} could not be loaded (${result.reason}). The product files may have been moved or deleted.`, checkedAt: new Date().toISOString() });
    }
    return this.#set({ status: PREVIEW_STATUS.running, error: null, checkedAt: new Date().toISOString() });
  }

  /** Stops the preview server. */
  async stop() {
    await this.#closeServer();
    this.product = null;
    return this.#set({ status: PREVIEW_STATUS.notStarted, workflowId: null, url: null, entry: null, title: null, error: null, startedAt: null, checkedAt: null });
  }

  async close() {
    await this.#closeServer();
  }

  async #start(workflowId) {
    this.product = null;
    this.#set({ status: PREVIEW_STATUS.starting, workflowId, url: null, entry: null, title: null, error: null, startedAt: null, checkedAt: null });

    let product;
    try {
      product = await this.resolveProduct(workflowId);
    } catch (error) {
      return this.#set({ status: PREVIEW_STATUS.error, error: error instanceof PreviewError ? error.message : `The product could not be located: ${error.message}` });
    }

    try {
      await this.#ensureServer();
    } catch (error) {
      return this.#set({ status: PREVIEW_STATUS.error, error: `The preview server could not start on ${this.host}:${this.port || 'auto'}: ${error.message}` });
    }

    this.product = { workflowId, dir: product.dir, entry: product.entry };
    const url = `http://${this.host}:${this.server.address().port}/${encodeURIComponent(workflowId)}/${product.entry}`;
    const result = await this.#check(url);
    const checkedAt = new Date().toISOString();
    if (!result.ok) {
      return this.#set({ status: PREVIEW_STATUS.error, url, entry: product.entry, title: product.title, error: `The preview server started, but ${product.entry} could not be loaded: ${result.reason}`, checkedAt });
    }
    return this.#set({ status: PREVIEW_STATUS.running, url, entry: product.entry, title: product.title, error: null, startedAt: checkedAt, checkedAt });
  }

  async #check(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.checkTimeoutMs), cache: 'no-store' });
      await res.arrayBuffer();
      return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, reason: error.name === 'TimeoutError' ? 'no response within the time limit' : error.message };
    }
  }

  #ensureServer() {
    if (this.server?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.#handle(req, res).catch((error) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Preview error: ${error.message}`);
        });
      });
      server.once('error', (error) => {
        server.close();
        reject(error);
      });
      server.listen(this.port, this.host, () => {
        server.removeAllListeners('error');
        server.on('error', (error) => this.#set({ status: PREVIEW_STATUS.error, error: `The preview server failed: ${error.message}` }));
        this.server = server;
        resolve();
      });
    });
  }

  async #closeServer() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  async #handle(req, res) {
    const notFound = (message) => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(message);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const { pathname } = new URL(req.url, 'http://preview');
    const [, rawId = '', ...rest] = pathname.split('/');
    const workflowId = decodeURIComponent(rawId);
    if (!this.product || workflowId !== this.product.workflowId) {
      notFound('This product is not being previewed. Start its preview from the dashboard.');
      return;
    }

    let relativePath;
    try {
      relativePath = rest.map(decodeURIComponent).join('/') || this.product.entry;
    } catch {
      notFound('Not found');
      return;
    }
    // Never serve hidden files such as the product's .git folder.
    if (relativePath.split('/').some((part) => part.startsWith('.'))) {
      notFound('Not found');
      return;
    }
    let file;
    try {
      file = resolveInside(this.product.dir, relativePath);
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      notFound('Not found');
      return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      notFound('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  #set(fields) {
    this.state = { ...this.state, ...fields };
    const snapshot = this.status();
    this.emit('change', snapshot);
    return snapshot;
  }
}
