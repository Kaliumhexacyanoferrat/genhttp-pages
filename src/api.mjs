// The calls the action makes to GenHTTP Lambda's REST API (/api/v1).
//
// A lambda is addressed by its editor key, which is part of the path. So no
// error, log line or exception here ever carries a URL: the key would end up
// in the build log.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const RETRIED = new Set([502, 503, 504]);

export class LambdaApi {
  constructor({ server, key, timeout = 600000, userAgent = 'genhttp-pages' }) {
    this.base = server.replace(/\/+$/, '') + '/api/v1';
    this.server = server.replace(/\/+$/, '');
    this.key = key;
    this.timeout = timeout;
    this.userAgent = userAgent;
  }

  lambda(path = '') {
    return `/lambdas/${encodeURIComponent(this.key)}${path}`;
  }

  async request(method, path, { json, body, contentType, query, what, attempts = 3, binary = false } = {}) {
    const url = new URL(this.base + path);

    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers = { 'User-Agent': this.userAgent, Accept: binary ? 'application/zip' : 'application/json' };

    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (body !== undefined) {
      headers['Content-Type'] = contentType ?? 'application/octet-stream';
    }

    for (let attempt = 1; ; attempt++) {
      let response;

      try {
        response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeout) });
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? `no answer within ${Math.round(this.timeout / 1000)} seconds` : (error?.cause?.code ?? error?.message ?? 'network error');

        if (attempt < attempts && error?.name !== 'TimeoutError') {
          await sleep(attempt * 3000);
          continue;
        }

        throw new ApiError(0, `Could not reach ${this.server} to ${what}: ${reason}.`);
      }

      if (RETRIED.has(response.status) && attempt < attempts) {
        await sleep(attempt * 3000);
        continue;
      }

      if (binary && response.ok) {
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      }

      const text = await response.text();

      let parsed;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!response.ok && response.status !== 422) {
        const message = parsed?.message ?? (text && text.length < 300 ? text : response.statusText);
        throw new ApiError(response.status, `${this.server} refused to ${what} (${response.status}): ${message}`, parsed);
      }

      return { status: response.status, body: parsed };
    }
  }

  /** The lambda, or null when the key names none. */
  async getLambda() {
    try {
      return (await this.request('GET', this.lambda(), { what: 'read the lambda' })).body;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getVersions() {
    return (await this.request('GET', this.lambda('/versions'), { what: 'list the versions' })).body ?? [];
  }

  /** The files of a version below a folder (or the one file of that name). */
  async getVersionFiles(version, folder) {
    return (await this.request('GET', this.lambda(`/versions/${version}`), { query: { folder }, what: 'read a version' })).body?.files ?? [];
  }

  /** A version's files as a zip, named as the lambda names them. */
  async getVersionZip(version) {
    return (await this.request('GET', this.lambda(`/versions/${version}/zip`), { binary: true, what: 'read the newest version' })).body;
  }

  async getFeatureZip(feature) {
    return (await this.request('GET', this.lambda(`/features/${encodeURIComponent(feature)}/zip`), { binary: true, what: 'read the preview' })).body;
  }

  async saveVersion(zip, { deploy, change, specification }) {
    return (await this.request('POST', this.lambda('/versions/zip'), {
      body: zip,
      contentType: 'application/zip',
      query: { deploy, change, specification },
      what: 'save the new version',
      attempts: 1
    })).body;
  }

  async deploy(version) {
    return (await this.request('POST', this.lambda('/deployment/start'), { json: { version }, what: 'put the version online' })).body;
  }

  async getSystem() {
    return (await this.request('GET', '/system', { what: 'read the limits' })).body;
  }

  async listFeatures() {
    return (await this.request('GET', this.lambda('/features'), { what: 'list the features' })).body ?? [];
  }

  async createFeature(name, specification) {
    return (await this.request('POST', this.lambda('/features'), { json: { name, specification }, what: 'start a feature for the preview' })).body;
  }

  async saveFeature(feature, zip, { change, specification }) {
    return (await this.request('PUT', this.lambda(`/features/${encodeURIComponent(feature)}/zip`), {
      body: zip,
      contentType: 'application/zip',
      query: { deploy: true, change, specification },
      what: 'save the preview',
      attempts: 1
    })).body;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
