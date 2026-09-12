/**
 * meta-core API Client for writing metadata
 * Fails gracefully if meta-core is unavailable (logs warning, returns without throwing)
 */

export class MetaCoreClient {
    constructor(private baseUrl: string) {}

    private async safeFetch(url: string, options: RequestInit): Promise<Response | null> {
        try {
            return await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
        } catch (error) {
            console.warn(`[MetaCoreClient] Warning: meta-core unavailable at ${this.baseUrl}`);
            return null;
        }
    }

    async setProperty(hashId: string, key: string, value: string): Promise<void> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
        if (response && !response.ok) {
            console.warn(`[MetaCoreClient] Failed to set property: ${response.status}`);
        }
    }

    async getProperty(hashId: string, key: string): Promise<string | null> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/${key}`, { method: 'GET' });
        if (!response || response.status === 404) return null;
        if (!response.ok) return null;
        const data = await response.json() as { value?: string };
        return data.value ?? null;
    }

    async mergeMetadata(hashId: string, metadata: Record<string, string>): Promise<void> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(metadata),
        });
        if (response && !response.ok) {
            console.warn(`[MetaCoreClient] Failed to merge metadata: ${response.status}`);
        }
    }

    async deleteProperty(hashId: string, key: string): Promise<void> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/${key}`, { method: 'DELETE' });
        if (response && !response.ok && response.status !== 404) {
            console.warn(`[MetaCoreClient] Failed to delete property: ${response.status}`);
        }
    }

    async addToSet(hashId: string, key: string, value: string): Promise<void> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}/_add/${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
        if (response && !response.ok) {
            console.warn(`[MetaCoreClient] Failed to add to set: ${response.status}`);
        }
    }

    async getMetadata(hashId: string): Promise<Record<string, string>> {
        const response = await this.safeFetch(`${this.baseUrl}/meta/${hashId}`, { method: 'GET' });
        if (!response || response.status === 404) return {};
        if (!response.ok) return {};
        const data = await response.json() as { metadata?: Record<string, string> };
        return data.metadata ?? {};
    }

    /**
     * Compute the CID (Content Identifier) for a file
     * Uses the meta-core /file/cid API endpoint
     */
    async computeFileCID(filePath: string): Promise<string | null> {
        try {
            const response = await this.safeFetch(`${this.baseUrl}/file/cid`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath }),
            });
            if (!response || !response.ok) return null;
            const data = await response.json() as { cid?: string };
            return data.cid ?? null;
        } catch (error) {
            console.debug(`[MetaCoreClient] Failed to compute CID for ${filePath}:`, error);
            return null;
        }
    }
}
