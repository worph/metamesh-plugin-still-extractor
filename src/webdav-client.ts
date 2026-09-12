/**
 * WebDAV Client for Plugin File Access
 *
 * Provides HTTP-based file access to meta-sort's WebDAV endpoint.
 * Replaces direct filesystem access for containerized plugins.
 */

export interface FileStats {
    size: number;
    mtime?: Date;
}

export class WebDAVClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        // Remove trailing slash if present
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    /**
     * Convert absolute file path to WebDAV URL
     * Strips /files prefix and appends to base URL
     */
    toWebDAVUrl(filePath: string): string {
        // filePath is like "/files/watch/movie.mkv"
        // We need to convert to "http://meta-sort-dev/webdav/watch/movie.mkv"
        let relativePath = filePath;

        // Strip /files prefix if present
        if (relativePath.startsWith('/files/')) {
            relativePath = relativePath.substring(6); // Remove "/files"
        } else if (relativePath.startsWith('/files')) {
            relativePath = relativePath.substring(6);
        }

        // Ensure path starts with /
        if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
        }

        return this.baseUrl + relativePath;
    }

    /**
     * Get file stats (size, mtime) via HTTP HEAD request
     */
    async stat(filePath: string): Promise<FileStats> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'HEAD' });

        if (!response.ok) {
            throw new Error(`WebDAV HEAD failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const lastModified = response.headers.get('last-modified');

        return {
            size: contentLength ? parseInt(contentLength, 10) : 0,
            mtime: lastModified ? new Date(lastModified) : undefined,
        };
    }

    /**
     * Read first N bytes of a file (for magic byte detection)
     * Uses HTTP Range request
     */
    async readBytes(filePath: string, start: number, end: number): Promise<Buffer> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Range': `bytes=${start}-${end}`,
            },
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`WebDAV Range GET failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Read entire file as buffer (for small files only)
     */
    async readFile(filePath: string): Promise<Buffer> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'GET' });

        if (!response.ok) {
            throw new Error(`WebDAV GET failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Write file via HTTP PUT
     */
    async writeFile(filePath: string, data: Buffer | string): Promise<void> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, {
            method: 'PUT',
            body: data,
            headers: {
                'Content-Type': 'application/octet-stream',
            },
        });

        if (!response.ok) {
            throw new Error(`WebDAV PUT failed for ${filePath}: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Check if file exists via HTTP HEAD
     */
    async exists(filePath: string): Promise<boolean> {
        const url = this.toWebDAVUrl(filePath);

        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch {
            return false;
        }
    }
}

/**
 * WebDAV client for the meta-core that drove a /process call.
 *
 * The endpoint is read from that core's own /urls (`webdavUrlInternal`),
 * so blobs always land in the /files of the core we write metadata to. A feeder
 * whose plugins run beside it but enrich a remote hub core needs no per-stack
 * wiring, and it is impossible to write posters into one core while pointing
 * CIDs at another.
 *
 * WEBDAV_URL still wins when set — an explicit override for tests and for
 * topologies where the core's advertised internal URL isn't reachable from here.
 *
 * Resolutions are cached per meta-core URL; failures are not, so a core that is
 * still starting up is retried on the next task.
 */
const clientCache = new Map<string, Promise<WebDAVClient | null>>();

async function resolveWebDAVUrl(metaCoreUrl: string): Promise<string | null> {
    // /urls, not /api/urls — metaCoreUrl points at the meta-core backend, whose
    // discovery routes are unprefixed (same base the /meta/* writes use).
    const base = metaCoreUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/urls`, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
        throw new Error(`GET ${base}/urls failed: ${response.status} ${response.statusText}`);
    }

    const urls = await response.json() as { webdavUrlInternal?: string; webdavUrl?: string };
    return urls.webdavUrlInternal ?? urls.webdavUrl ?? null;
}

export async function getWebDAVClient(metaCoreUrl: string): Promise<WebDAVClient | null> {
    const override = process.env.WEBDAV_URL;
    if (override) {
        return new WebDAVClient(override);
    }

    let pending = clientCache.get(metaCoreUrl);
    if (!pending) {
        pending = resolveWebDAVUrl(metaCoreUrl).then((webdavUrl) => {
            if (!webdavUrl) {
                console.warn(`[webdav-client] meta-core ${metaCoreUrl} advertises no WebDAV URL`);
                return null;
            }
            console.log(`[webdav-client] Using WebDAV endpoint ${webdavUrl} (from ${metaCoreUrl})`);
            return new WebDAVClient(webdavUrl);
        });
        clientCache.set(metaCoreUrl, pending);
    }

    try {
        const client = await pending;
        if (!client) {
            clientCache.delete(metaCoreUrl);
        }
        return client;
    } catch (error) {
        clientCache.delete(metaCoreUrl);
        console.warn(`[webdav-client] Failed to resolve WebDAV URL from ${metaCoreUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
