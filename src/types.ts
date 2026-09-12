/**
 * MetaMesh Plugin Types
 */

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    dependencies?: string[];
    schema?: Record<string, SchemaField>;
    config?: Record<string, ConfigField>;
    priority?: number;
    color?: string;
    defaultQueue?: 'fast' | 'background';
    timeout?: number;
}

export interface SchemaField {
    label: string;
    type?: 'string' | 'number' | 'boolean' | 'select' | 'text' | 'array' | 'json' | 'cid';
    readonly?: boolean;
    hint?: string;
}

export interface ConfigField {
    type: 'string' | 'number' | 'boolean' | 'select';
    label?: string;
    required?: boolean;
    default?: unknown;
    secret?: boolean;
}

export interface HealthResponse {
    status: 'healthy' | 'unhealthy';
    ready: boolean;
    version: string;
}

export interface ProcessRequest {
    taskId: string;
    cid: string;
    filePath: string;
    callbackUrl: string;
    metaCoreUrl: string;
    existingMeta?: Record<string, string>;
}

export interface ProcessResponse {
    status: 'accepted' | 'rejected';
    error?: string;
}

export interface CallbackPayload {
    taskId: string;
    status: 'completed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    reason?: string;
}

export interface ConfigureRequest {
    config: Record<string, unknown>;
}

export interface ConfigureResponse {
    status: 'ok' | 'error';
    error?: string;
}
