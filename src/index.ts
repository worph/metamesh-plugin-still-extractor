/**
 * MetaMesh Plugin: still-extractor
 *
 * ============================================================================
 * PLUGIN FILE ACCESS ARCHITECTURE - WebDAV
 * ============================================================================
 *
 * File access via WebDAV, resolved per request from the calling meta-core's
 *   /urls -> webdavUrlInternal (WEBDAV_URL overrides):
 *   - Read media files:  GET  /webdav/watch/...  or /webdav/test/...
 *   - Write output:      PUT  /webdav/plugin/still-extractor/...
 *   - Temp:              Local /cache/temp mount (frame written before WebDAV upload)
 *
 * SECURITY: Plugins use WebDAV for all file access. No /files mount needed.
 *
 * ============================================================================
 */

import Fastify from 'fastify';
import type { HealthResponse, ProcessRequest, ProcessResponse, CallbackPayload, ConfigureRequest, ConfigureResponse } from './types.js';
import { manifest, process as processFile, configure } from './plugin.js';

const app = Fastify({ logger: true });
let ready = false;

app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'healthy',
    ready,
    version: manifest.version
}));

app.get('/manifest', async () => manifest);

app.post<{ Body: ConfigureRequest }>('/configure', async (request): Promise<ConfigureResponse> => {
    try {
        configure(request.body.config || {});
        console.log(`[${manifest.id}] Configuration updated`);
        return { status: 'ok' };
    } catch (error) {
        console.error(`[${manifest.id}] Configuration error:`, error);
        return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
});

app.post<{ Body: ProcessRequest }>('/process', async (request, reply) => {
    const { taskId, cid, filePath, callbackUrl, metaCoreUrl } = request.body;

    if (!taskId || !cid || !filePath || !callbackUrl || !metaCoreUrl) {
        return reply.send({ status: 'rejected', error: 'Missing required fields' } as ProcessResponse);
    }

    // Process asynchronously and send callback when done
    processFile(request.body, async (payload: CallbackPayload) => {
        try {
            await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (error) {
            console.error(`[${manifest.id}] Callback error:`, error);
        }
    }).catch((error) => {
        console.error(`[${manifest.id}] Process error:`, error);
    });

    return reply.send({ status: 'accepted' } as ProcessResponse);
});

const port = parseInt(process.env.PORT || '8080', 10);

app.listen({ port, host: '0.0.0.0' }).then(() => {
    ready = true;
    console.log(`[${manifest.id}] Listening on port ${port}`);
});

process.on('SIGTERM', async () => {
    ready = false;
    await app.close();
    process.exit(0);
});
