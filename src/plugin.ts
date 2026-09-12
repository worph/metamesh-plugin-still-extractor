/**
 * Still Extractor Plugin
 *
 * Grabs a representative frame out of a local video file and stores it as a
 * content-addressed JPEG, referenced from the video record as `still`.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Artwork on a local file otherwise comes from TMDB, and only when a title
 * match succeeds. `still` (METADATA_KEYS.md section 6.1) is the episode-level
 * thumbnail slot, reserved for a future TMDB season-detail fetch and until now
 * written by nobody. This plugin gives it a first writer from the one source
 * that never 404s and never depends on a match: the file itself.
 *
 * A still is NOT a poster. Nothing gates on it and its absence is not an error
 * — hence `skipped` rather than `failed` on every "couldn't get a usable
 * frame" path. We never write `poster`: a frame grab masquerading as a real
 * poster would propagate to every peer that replicates the record.
 *
 * ============================================================================
 * PLUGIN FILE ACCESS ARCHITECTURE - WebDAV
 * ============================================================================
 * File access via WebDAV, on the meta-core named by each /process request
 * (its /urls -> webdavUrlInternal; WEBDAV_URL overrides):
 *   - Read media files:  GET  /webdav/watch/...  or /webdav/test/...
 *   - Write output:      PUT  /webdav/plugin/still-extractor/...
 *   - Temp:              /cache/temp (frame written by ffmpeg before upload)
 *
 * We deliberately do NOT write a `stillPath` sibling. METADATA_KEYS.md names
 * one, but that is the gateway/peer_proxy mirroring convention: on the
 * meta-sort path `/files/plugin` is a watcher root
 * (meta-core/internal/config/config.go DefaultWatcherPaths), so the JPEG gets
 * its own record and midhash alias and `LookupPathByCID` resolves it through
 * the reverse index — "There is no path-companion sidecar field"
 * (meta-core/internal/storage/client.go). The tmdb plugin writes `poster`
 * without `posterPath` for the same reason.
 * ============================================================================
 */

import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import * as path from 'path';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { getWebDAVClient, WebDAVClient } from './webdav-client.js';

const PLUGIN_OUTPUT_WEBDAV_PATH = '/files/plugin/still-extractor';
const TEMP_PATH = '/cache/temp';

export const manifest: PluginManifest = {
    id: 'still-extractor',
    name: 'Still Extractor',
    version: '1.0.0',
    description: 'Extracts a representative frame from a video file and stores it as the record\'s `still`',
    author: 'MetaMesh',
    // file-info gives us `fileType`; ffmpeg gives us `fileinfo/duration` and
    // the `stream/{n}` table we pick the primary video stream out of.
    dependencies: ['file-info', 'ffmpeg'],
    priority: 55,
    color: '#9C27B0',
    // One seek + one decode over HTTP. Never the fast queue.
    defaultQueue: 'background',
    timeout: 300000,
    schema: {
        still: {
            label: 'Still',
            type: 'cid',
            readonly: true,
            hint: 'CID of a frame extracted from the video itself (best-effort episode thumbnail)',
        },
    },
    config: {
        forceRecompute: { type: 'boolean', label: 'Force Recompute', default: false },
        seekPercents: { type: 'string', label: 'Seek Percents', default: '20,45,70' },
        maxWidth: { type: 'number', label: 'Max Width (px)', default: 640 },
        jpegQuality: { type: 'number', label: 'JPEG Quality (ffmpeg -q:v, lower is better)', default: 4 },
        frameTimeoutMs: { type: 'number', label: 'Per-Frame ffmpeg Timeout (ms)', default: 120000 },
    },
};

// Configuration
let forceRecompute = false;
let seekPercents = [20, 45, 70];
let maxWidth = 640;
let jpegQuality = 4;
let frameTimeoutMs = 120000;

export function configure(config: Record<string, unknown>): void {
    forceRecompute = config.forceRecompute === true;
    if (typeof config.seekPercents === 'string') {
        const parsed = config.seekPercents
            .split(',')
            .map((p) => Number(p.trim()))
            .filter((p) => Number.isFinite(p) && p > 0 && p < 100);
        if (parsed.length > 0) seekPercents = parsed;
    }
    if (Number.isFinite(Number(config.maxWidth))) maxWidth = Number(config.maxWidth);
    if (Number.isFinite(Number(config.jpegQuality))) jpegQuality = Number(config.jpegQuality);
    if (Number.isFinite(Number(config.frameTimeoutMs))) frameTimeoutMs = Number(config.frameTimeoutMs);
    console.log(
        `[still-extractor] Config: forceRecompute=${forceRecompute}, seekPercents=${seekPercents.join(',')}, ` +
        `maxWidth=${maxWidth}, jpegQuality=${jpegQuality}, frameTimeoutMs=${frameTimeoutMs}`
    );
}

/**
 * Compute midhash256 CID from a Buffer (matches meta-hash algorithm).
 * Copied verbatim from metamesh-plugin-subtitle-extractor.
 */
export function computeMidHash256FromBuffer(data: Buffer): string {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);

    const fileSize = data.length;

    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        sampleData = data;
    } else {
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        sampleData = data.subarray(middleOffset, middleOffset + SAMPLE_SIZE);
    }

    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256').update(hashInput).digest();

    const cidBytes = Buffer.concat([
        Buffer.from([0x01]),
        MIDHASH_VARINT,
        MIDHASH_VARINT,
        Buffer.from([0x20]),
        hashBuffer
    ]);

    const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let cid = 'b';
    let bits = 0;
    let value = 0;
    for (const byte of cidBytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            cid += base32Chars[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        cid += base32Chars[(value << (5 - bits)) & 0x1f];
    }

    return cid;
}

/** Sanitize filename by removing invalid characters. */
export function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Output filename for a still.
 *
 * The source CID is part of the name — unlike the tmdb plugin, which
 * deliberately leaves the file CID out so every release of one movie shares a
 * poster. A still belongs to exactly one file, so two files with the same
 * basename must not collide.
 */
export function stillFilename(filePath: string, sourceCid: string): string {
    const base = sanitizeFilename(path.basename(filePath, path.extname(filePath)));
    const shortCid = sourceCid.slice(-12);
    return `${base}[${shortCid}]_still.jpg`;
}

export interface VideoStream {
    /** Absolute ffmpeg stream index — what `-map 0:<index>` wants. */
    index: number;
    width?: number;
    height?: number;
    codec?: string;
    frameRate?: string;
}

/**
 * Codecs that are a single picture, not a moving image. An `attached_pic`
 * stream is almost always one of these.
 */
const STILL_IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff']);

/**
 * Pick the primary video stream out of the ffmpeg plugin's `stream/{n}` table.
 *
 * ⚠ NOT `0:v:0`, and ⚠ not simply the largest. ffprobe reports attached cover
 * art (`attached_pic`) as `codec_type=video`, and the ffmpeg plugin's
 * `embeddedimage` branch never fires for it, so an embedded poster lands here
 * as a perfectly ordinary `type:'video'` stream — which `0:v:0` would happily
 * extract instead of the film. Nor can we just take the biggest: a 600x900
 * cover out-measures a 640x480 video.
 *
 * The stream table does not carry dispositions, so we use what it does carry.
 * The ffmpeg plugin drops `avg_frame_rate` when it is `0/0` (plugin.ts), and an
 * attached picture has no frame rate — so "has a frameRate and is not a
 * still-image codec" separates moving pictures from covers. Largest area wins
 * within the better class; if nothing looks like moving video we fall back to
 * the largest of whatever is there rather than giving up.
 *
 * Accepts both shapes meta-core hands back: the namespaced `stream/{n}` keys
 * the ffmpeg plugin writes, and the flattened `stream` array.
 */
export function selectPrimaryVideoStream(existingMeta: Record<string, string> | undefined): VideoStream | null {
    if (!existingMeta) return null;

    const raw: unknown[] = [];

    const flattened = existingMeta['stream'] as unknown;
    if (flattened) {
        try {
            const arr = Array.isArray(flattened) ? flattened : JSON.parse(String(flattened));
            if (Array.isArray(arr)) raw.push(...arr);
        } catch {
            // fall through to the namespaced form
        }
    }

    if (raw.length === 0) {
        for (const [key, value] of Object.entries(existingMeta)) {
            if (key.startsWith('stream/')) raw.push(value);
        }
    }

    const moving: VideoStream[] = [];
    const other: VideoStream[] = [];

    for (const entry of raw) {
        let stream: {
            type?: string; index?: number; width?: number; height?: number;
            codec?: string; frameRate?: string;
        };
        try {
            stream = typeof entry === 'string' ? JSON.parse(entry) : (entry as typeof stream);
        } catch {
            continue;
        }
        if (!stream || stream.type !== 'video' || stream.index == null) continue;

        const candidate: VideoStream = {
            index: Number(stream.index),
            width: stream.width != null ? Number(stream.width) : undefined,
            height: stream.height != null ? Number(stream.height) : undefined,
            codec: stream.codec,
            frameRate: stream.frameRate,
        };

        const looksMoving =
            !!candidate.frameRate && !STILL_IMAGE_CODECS.has((candidate.codec ?? '').toLowerCase());
        (looksMoving ? moving : other).push(candidate);
    }

    const area = (s: VideoStream) => (s.width ?? 0) * (s.height ?? 0);
    const pool = moving.length > 0 ? moving : other;
    return pool.reduce<VideoStream | null>((best, s) => (!best || area(s) > area(best) ? s : best), null);
}

/**
 * Seek offsets to try, in order.
 *
 * Clamped away from both ends: the head is titles/logos/black and the tail is
 * credits. A file with no usable duration gets a blind 10s attempt and then
 * the very start, which is all we can honestly do.
 */
export function candidateOffsets(durationSec: number | undefined, percents: number[] = seekPercents): number[] {
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
        return [10, 0];
    }
    if (durationSec <= 4) {
        return [Math.max(0, durationSec / 2)];
    }
    const lo = 2;
    const hi = durationSec - 2;
    const offsets = percents
        .map((p) => (durationSec * p) / 100)
        .map((t) => Math.min(hi, Math.max(lo, t)));
    return Array.from(new Set(offsets.map((t) => Math.round(t * 1000) / 1000)));
}

export interface FrameStats {
    mean: number;
    stddev: number;
}

/** Mean + standard deviation of an 8-bit grayscale buffer, both 0..255. */
export function frameStats(gray: Buffer): FrameStats {
    if (gray.length === 0) return { mean: 0, stddev: 0 };
    let sum = 0;
    for (const v of gray) sum += v;
    const mean = sum / gray.length;
    let variance = 0;
    for (const v of gray) variance += (v - mean) ** 2;
    return { mean, stddev: Math.sqrt(variance / gray.length) };
}

/**
 * Is this frame worth keeping?
 *
 * Rejects the three things a blind seek lands on far more often than you would
 * expect: a black frame, a white/blown card, and a flat single-colour fade.
 * `thumbnail=N` already avoids most of them; this is the backstop.
 */
export function isUsableFrame(stats: FrameStats): boolean {
    if (stats.stddev < 6) return false;          // flat: fade, solid colour, blank card
    if (stats.mean < 12 || stats.mean > 243) return false; // black / blown out
    return true;
}

/** Run a command, resolving with its exit code, stdout and stderr. Killed hard on timeout. */
function run(
    cmd: string,
    args: string[],
    timeoutMs: number
): Promise<{ code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => stdout.push(d));
        child.stderr.on('data', (d: Buffer) => {
            // Keep the tail only — a broken input can spew megabytes.
            stderr = (stderr + d.toString()).slice(-4000);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: null, stdout: Buffer.concat(stdout), stderr: stderr + String(err), timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(stdout), stderr, timedOut });
        });
    });
}

/**
 * Grab one frame at `offsetSec` and return the encoded JPEG.
 *
 * ⚠ `-ss` goes BEFORE `-i`. Input seeking makes ffmpeg jump via HTTP Range;
 * output seeking (`-ss` after `-i`) decodes every frame from zero, which over
 * WebDAV means pulling the whole file to reach the 20% mark. On MKV expect a
 * tail read regardless — the cue index lives at EOF.
 */
export async function grabFrame(
    input: string,
    streamIndex: number,
    offsetSec: number,
    outputPath: string
): Promise<Buffer | null> {
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];

    // rw_timeout is a protocol option; only http/tcp accept it, and passing it
    // to the file protocol makes ffmpeg bail before it starts.
    if (/^https?:\/\//i.test(input)) {
        args.push('-rw_timeout', '30000000'); // microseconds
    }

    args.push(
        '-ss', String(offsetSec),
        '-i', input,
        '-map', `0:${streamIndex}`,
        '-an', '-sn', '-dn',
        '-frames:v', '1',
        // thumbnail=N picks the most representative of the next N frames rather
        // than whatever the seek happened to land on.
        '-vf', `thumbnail=60,scale='min(iw,${maxWidth})':-2`,
        '-q:v', String(jpegQuality),
        '-f', 'image2',
        outputPath
    );

    const result = await run('ffmpeg', args, frameTimeoutMs);
    if (result.timedOut) {
        console.warn(`[still-extractor] ffmpeg timed out at ${offsetSec}s`);
        return null;
    }
    if (result.code !== 0 || !existsSync(outputPath)) {
        console.warn(`[still-extractor] ffmpeg failed at ${offsetSec}s: ${result.stderr.trim() || `exit ${result.code}`}`);
        return null;
    }

    const jpeg = readFileSync(outputPath);
    return jpeg.length > 0 ? jpeg : null;
}

/**
 * Measure a JPEG we already have on disk.
 *
 * Deliberately a second ffmpeg pass on the local temp file rather than a second
 * output on the grab command: two filter chains off one input would each run
 * their own `thumbnail` instance, and there is no guarantee the frame we
 * measured is the frame we encoded. This decodes a ~40 KB local file — no
 * seek, no network.
 */
export async function statsForJpeg(jpegPath: string): Promise<FrameStats | null> {
    const result = await run(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', jpegPath,
         '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-'],
        15000
    );
    if (result.code !== 0 || result.stdout.length === 0) return null;
    return frameStats(result.stdout);
}

export interface ExtractResult {
    jpeg: Buffer;
    offsetSec: number;
    stats: FrameStats;
}

/**
 * Walk the candidate offsets until one yields a usable frame.
 *
 * Returns null when every candidate was black, flat, or unreadable — that is a
 * `skipped`, not a failure.
 */
export async function extractStill(
    input: string,
    streamIndex: number,
    durationSec: number | undefined,
    tempPath: string = TEMP_PATH
): Promise<ExtractResult | null> {
    mkdirSync(tempPath, { recursive: true });
    // NB: `process` is this module's own export, not node's global — hence a
    // random suffix rather than a pid for uniqueness between concurrent tasks.
    const outputPath = path.join(tempPath, `still-${randomBytes(6).toString('hex')}.jpg`);

    try {
        for (const offsetSec of candidateOffsets(durationSec)) {
            const jpeg = await grabFrame(input, streamIndex, offsetSec, outputPath);
            if (!jpeg) continue;

            const stats = await statsForJpeg(outputPath);
            if (!stats) {
                console.warn(`[still-extractor] Could not measure frame at ${offsetSec}s`);
                continue;
            }
            if (!isUsableFrame(stats)) {
                console.log(
                    `[still-extractor] Rejected frame at ${offsetSec}s ` +
                    `(mean=${stats.mean.toFixed(1)}, stddev=${stats.stddev.toFixed(1)})`
                );
                continue;
            }

            console.log(
                `[still-extractor] Accepted frame at ${offsetSec}s ` +
                `(mean=${stats.mean.toFixed(1)}, stddev=${stats.stddev.toFixed(1)}, ${jpeg.length} bytes)`
            );
            return { jpeg, offsetSec, stats };
        }
        return null;
    } finally {
        if (existsSync(outputPath)) {
            try { unlinkSync(outputPath); } catch { /* best effort */ }
        }
    }
}

/** Upload the frame and return its CID. */
async function storeStill(
    client: WebDAVClient,
    jpeg: Buffer,
    filePath: string,
    sourceCid: string
): Promise<string> {
    const webdavPath = `${PLUGIN_OUTPUT_WEBDAV_PATH}/${stillFilename(filePath, sourceCid)}`;
    await client.writeFile(webdavPath, jpeg);
    console.log(`[still-extractor] Uploaded still to WebDAV: ${webdavPath}`);
    return computeMidHash256FromBuffer(jpeg);
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const { taskId, cid, filePath, existingMeta } = request;
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    const skip = (reason: string) =>
        sendCallback({ taskId, status: 'skipped', duration: Date.now() - startTime, reason });

    try {
        if (existingMeta?.fileType !== 'video') {
            await skip('Not a video file');
            return;
        }

        if (existingMeta?.still && !forceRecompute) {
            // Also the mechanism that keeps this plugin from ever fighting a
            // future TMDB episode-still writer: authoritative artwork wins by
            // arriving first and never being overwritten from here.
            await skip('Still already present');
            return;
        }

        const stream = selectPrimaryVideoStream(existingMeta);
        if (!stream) {
            await skip('No video stream');
            return;
        }

        // WebDAV of the very core we're enriching, so the frame bytes and the
        // CID we write can never point at different cores.
        const webdavClient = await getWebDAVClient(request.metaCoreUrl);
        if (!webdavClient) {
            await sendCallback({
                taskId,
                status: 'failed',
                duration: Date.now() - startTime,
                error: 'No WebDAV endpoint available',
            });
            return;
        }

        const duration = Number(existingMeta?.['fileinfo/duration']);
        const input = webdavClient.toWebDAVUrl(filePath);

        const extracted = await extractStill(input, stream.index, Number.isFinite(duration) ? duration : undefined);
        if (!extracted) {
            await skip('No usable frame');
            return;
        }

        const stillCid = await storeStill(webdavClient, extracted.jpeg, filePath, cid);
        await metaCore.setProperty(cid, 'still', stillCid);
        console.log(`[still-extractor] Set still CID: ${stillCid}`);

        await sendCallback({ taskId, status: 'completed', duration: Date.now() - startTime });
    } catch (error) {
        console.error(`[still-extractor] Error processing ${filePath}:`, error);
        await sendCallback({
            taskId,
            status: 'failed',
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
