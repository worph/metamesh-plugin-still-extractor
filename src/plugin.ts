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
        maxConcurrent: { type: 'number', label: 'Max Concurrent Extractions', default: 1 },
    },
};

// Configuration
let forceRecompute = false;
let seekPercents = [20, 45, 70];
let maxWidth = 640;
let jpegQuality = 4;
let frameTimeoutMs = 120000;
let maxConcurrent = 1;

/**
 * A config value as a number, or undefined when it is absent.
 *
 * ⚠ Not `Number.isFinite(Number(v))`: `Number(null)` and `Number('')` are both
 * `0`, so a config payload carrying `"maxWidth": null` would silently set a
 * 0-pixel width or a 0 ms timeout.
 */
function configNumber(v: unknown): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function configure(config: Record<string, unknown>): void {
    forceRecompute = config.forceRecompute === true;
    if (typeof config.seekPercents === 'string') {
        const parsed = config.seekPercents
            .split(',')
            .map((p) => Number(p.trim()))
            .filter((p) => Number.isFinite(p) && p > 0 && p < 100);
        if (parsed.length > 0) seekPercents = parsed;
    }
    const width = configNumber(config.maxWidth);
    if (width !== undefined && width > 0) maxWidth = width;
    const quality = configNumber(config.jpegQuality);
    if (quality !== undefined && quality >= 1 && quality <= 31) jpegQuality = quality;
    const timeout = configNumber(config.frameTimeoutMs);
    if (timeout !== undefined && timeout > 0) frameTimeoutMs = timeout;
    const concurrent = configNumber(config.maxConcurrent);
    if (concurrent !== undefined && concurrent >= 1) maxConcurrent = Math.floor(concurrent);
    console.log(
        `[still-extractor] Config: forceRecompute=${forceRecompute}, seekPercents=${seekPercents.join(',')}, ` +
        `maxWidth=${maxWidth}, jpegQuality=${jpegQuality}, frameTimeoutMs=${frameTimeoutMs}, maxConcurrent=${maxConcurrent}`
    );
}

let activeExtractions = 0;
const extractionWaiters: Array<() => void> = [];

/**
 * Run `fn` once an extraction slot is free.
 *
 * meta-sort's background queue dispatches several tasks at this single
 * instance at once, and each ffmpeg grab of a 1080p file peaks near 200 MiB
 * even with the scale-first chain. Four at a time OOM-killed the 512 MiB
 * container on the dev stack (`OOMKilled=true`, ffmpeg dying on SIGKILL). The
 * container gets one CPU, so running them concurrently buys no throughput
 * anyway — the cap lives here so it holds whatever the scheduler sends.
 */
export async function withExtractionSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (activeExtractions >= maxConcurrent) {
        await new Promise<void>((resolve) => extractionWaiters.push(resolve));
    }
    activeExtractions++;
    try {
        return await fn();
    } finally {
        activeExtractions--;
        extractionWaiters.shift()?.();
    }
}

/**
 * Files that produced no usable frame, remembered briefly by cid.
 *
 * A failed extraction writes no `still`, so the slot-time re-check cannot stop
 * the duplicates a replay or rescan queues behind it — on the dev stack a 17s
 * title-card test clip was fully decoded a dozen times in a row. An in-memory
 * TTL absorbs that burst without inventing a persisted "tried and failed" key,
 * and a rescan after the TTL still gets a fresh attempt.
 */
const NO_USABLE_FRAME_TTL_MS = 60 * 60 * 1000;
const noUsableFrameAt = new Map<string, number>();

export function recentlyFailed(cid: string, now = Date.now()): boolean {
    const at = noUsableFrameAt.get(cid);
    if (at === undefined) return false;
    if (now - at > NO_USABLE_FRAME_TTL_MS) {
        noUsableFrameAt.delete(cid);
        return false;
    }
    return true;
}

export function rememberNoUsableFrame(cid: string, now = Date.now()): void {
    noUsableFrameAt.set(cid, now);
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
    /** ffprobe's `attached_pic` disposition. Probe path only — the ffmpeg
     *  plugin's stream table does not carry dispositions. */
    attachedPic?: boolean;
}

/**
 * `fileinfo/duration` out of whichever shape the payload carries.
 *
 * ⚠ meta-sort's /process payload is the NESTED document form — `fileinfo:
 * { duration }`, `stream: [...]`, `cids: [...]` — not meta-core's flat
 * `fileinfo/duration` keys. On the dev stack every task's existingMeta had
 * `fileinfo` and `stream`, never `fileinfo/duration`, and reading only the flat
 * key sent 16 of 16 stills to the 10s/0s fallback. Accept both, plus a
 * JSON-string `fileinfo`.
 */
export function durationFromMeta(existingMeta: Record<string, unknown> | undefined): number | undefined {
    if (!existingMeta) return undefined;
    let fileinfo: unknown = existingMeta['fileinfo'];
    if (typeof fileinfo === 'string') {
        try { fileinfo = JSON.parse(fileinfo); } catch { fileinfo = undefined; }
    }
    const raw = existingMeta['fileinfo/duration']
        ?? (fileinfo && typeof fileinfo === 'object' ? (fileinfo as Record<string, unknown>)['duration'] : undefined);
    if (raw === null || raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
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
 * Accepts both shapes: the nested `stream` collection meta-sort's /process
 * payload actually carries (array, JSON string, or index-keyed object), and the
 * namespaced `stream/{n}` keys meta-core stores.
 */
export function selectPrimaryVideoStream(existingMeta: Record<string, string> | undefined): VideoStream | null {
    if (!existingMeta) return null;

    const raw: unknown[] = [];

    const nested = existingMeta['stream'] as unknown;
    if (nested) {
        try {
            const parsed = typeof nested === 'string' ? JSON.parse(nested) : nested;
            if (Array.isArray(parsed)) raw.push(...parsed);
            else if (parsed && typeof parsed === 'object') raw.push(...Object.values(parsed as Record<string, unknown>));
        } catch {
            // fall through to the namespaced form
        }
    }

    if (raw.length === 0) {
        for (const [key, value] of Object.entries(existingMeta)) {
            if (key.startsWith('stream/')) raw.push(value);
        }
    }

    const candidates: VideoStream[] = [];
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

        candidates.push({
            index: Number(stream.index),
            width: stream.width != null ? Number(stream.width) : undefined,
            height: stream.height != null ? Number(stream.height) : undefined,
            codec: stream.codec,
            frameRate: stream.frameRate,
        });
    }
    return pickPrimaryVideoStream(candidates);
}

/**
 * The moving picture among video candidates, wherever they came from.
 *
 * Prefers streams that have a frame rate, are not a still-image codec and are
 * not flagged as an attached picture; the largest area wins within that class,
 * falling back to the largest of the rest rather than giving up.
 */
export function pickPrimaryVideoStream(candidates: VideoStream[]): VideoStream | null {
    const looksMoving = (v: VideoStream) =>
        !v.attachedPic && !!v.frameRate && !STILL_IMAGE_CODECS.has((v.codec ?? '').toLowerCase());
    const moving = candidates.filter(looksMoving);
    const pool = moving.length > 0 ? moving : candidates;
    const area = (v: VideoStream) => (v.width ?? 0) * (v.height ?? 0);
    return pool.reduce<VideoStream | null>((best, v) => (!best || area(v) > area(best) ? v : best), null);
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
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string; timedOut: boolean }> {
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
            resolve({ code: null, signal: null, stdout: Buffer.concat(stdout), stderr: stderr + String(err), timedOut });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout: Buffer.concat(stdout), stderr, timedOut });
        });
    });
}

export interface MediaProbe {
    duration?: number;
    videoStreams: VideoStream[];
}

/**
 * Duration and video streams read straight from the file.
 *
 * Both normally arrive from the ffmpeg plugin, but meta-sort marks a dependency
 * complete on `failed` and `skipped` callbacks as well as `completed`
 * (ContainerPluginScheduler.markPluginCompleted), so a still task can run
 * against a record missing either — or both: on the dev stack a midhash record
 * had `fileType=video` and no `fileinfo` or `stream` at all. Without a duration
 * frame choice falls back to 10s/0s (idents and opening credits); without
 * streams there is nothing to map. One header-only ffprobe answers both.
 */
export async function probeMedia(input: string): Promise<MediaProbe> {
    const args = ['-v', 'error'];
    if (/^https?:\/\//i.test(input)) {
        args.push('-rw_timeout', '30000000'); // microseconds
    }
    args.push('-print_format', 'json', '-show_format', '-show_streams', input);

    const result = await run('ffprobe', args, 30000);
    if (result.timedOut || result.code !== 0) return { videoStreams: [] };

    let parsed: {
        format?: { duration?: string };
        streams?: Array<{
            codec_type?: string; index?: number; codec_name?: string;
            width?: number; height?: number; avg_frame_rate?: string;
            disposition?: { attached_pic?: number };
        }>;
    };
    try {
        parsed = JSON.parse(result.stdout.toString());
    } catch {
        return { videoStreams: [] };
    }

    const duration = Number(parsed.format?.duration);
    const videoStreams = (parsed.streams ?? [])
        .filter((v) => v.codec_type === 'video' && v.index != null)
        .map((v): VideoStream => ({
            index: Number(v.index),
            width: v.width,
            height: v.height,
            codec: v.codec_name,
            frameRate: v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : undefined,
            attachedPic: v.disposition?.attached_pic === 1,
        }));
    return { duration: Number.isFinite(duration) && duration > 0 ? duration : undefined, videoStreams };
}

/** Container duration read from the file — see probeMedia. */
export async function probeDuration(input: string): Promise<number | undefined> {
    return (await probeMedia(input)).duration;
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
    // -threads caps the decoder's thread pool. Left alone, dav1d/hevc size it
    // to the host's cores, and every thread holds its own frame buffers.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '2'];

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
        // than whatever the seek happened to land on — and it BUFFERS all N.
        // ⚠ Scale first. `thumbnail=60,scale=…` holds 60 full-resolution frames;
        // on a 1080p AV1 episode that peaked at 409 MiB, and `scale=…,thumbnail=60`
        // at 196 MiB (and 2s instead of 4s) for a byte-for-byte comparable JPEG.
        '-vf', `scale='min(iw,${maxWidth})':-2,thumbnail=60`,
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
        // A signal with no stderr is the kernel, not ffmpeg: in practice the
        // OOM killer. Say so, instead of the old unhelpful "exit null".
        const why = result.signal
            ? `killed by ${result.signal}${result.signal === 'SIGKILL' ? ' (likely out of memory)' : ''}`
            : result.stderr.trim() || `exit ${result.code}`;
        console.warn(`[still-extractor] ffmpeg failed at ${offsetSec}s: ${why}`);
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

    const skip = (reason: string, quiet = false) => {
        // Every non-video file in the library comes through here too — logging
        // those would bury the skips that matter ("No video stream" on a video).
        if (!quiet) console.log(`[still-extractor] ${filePath}: skipped — ${reason}`);
        return sendCallback({ taskId, status: 'skipped', duration: Date.now() - startTime, reason });
    };

    try {
        if (existingMeta?.fileType !== 'video') {
            await skip('Not a video file', true);
            return;
        }

        if (existingMeta?.still && !forceRecompute) {
            // Also the mechanism that keeps this plugin from ever fighting a
            // future TMDB episode-still writer: authoritative artwork wins by
            // arriving first and never being overwritten from here.
            await skip('Still already present');
            return;
        }

        let stream = selectPrimaryVideoStream(existingMeta);

        // WebDAV of the very core we're enriching, so the frame bytes and the
        // CID we write can never point at different cores.
        const webdavClient = await getWebDAVClient(request.metaCoreUrl);
        if (!webdavClient) {
            if (!stream) {
                // Nothing in the record and no way to read the file.
                await skip('No video stream');
                return;
            }
            await sendCallback({
                taskId,
                status: 'failed',
                duration: Date.now() - startTime,
                error: 'No WebDAV endpoint available',
            });
            return;
        }

        const input = webdavClient.toWebDAVUrl(filePath);
        let probe: MediaProbe | undefined;
        const probeOnce = async () => (probe ??= await probeMedia(input));

        let streamSource = '';
        if (!stream) {
            stream = pickPrimaryVideoStream((await probeOnce()).videoStreams);
            streamSource = ' [probed]';
            if (!stream) {
                await skip('No video stream');
                return;
            }
        }

        const recordDuration = durationFromMeta(existingMeta as Record<string, unknown> | undefined);

        if (recordDuration === undefined) {
            // Name what this task actually received, so an upstream cause of a
            // missing duration stays diagnosable even though we recover from it.
            const keys = Object.keys(existingMeta ?? {});
            console.warn(
                `[still-extractor] ${filePath}: no usable fileinfo/duration ` +
                `(fileinfo=${JSON.stringify((existingMeta as Record<string, unknown> | undefined)?.['fileinfo'] ?? existingMeta?.['fileinfo/duration'] ?? null).slice(0, 120)}), probing the file; ` +
                `existingMeta has ${keys.length} keys: ${keys.slice(0, 40).join(', ')}`
            );
        }
        const duration = recordDuration ?? (await probeOnce()).duration;
        const durationSource = recordDuration !== undefined ? 'record' : duration !== undefined ? 'probed' : 'unknown';

        console.log(
            `[still-extractor] ${filePath}: stream=0:${stream.index}${streamSource} ` +
            `${stream.width ?? '?'}x${stream.height ?? '?'} ${stream.codec ?? ''} ` +
            `duration=${duration ?? 'unknown'} (${durationSource}) ` +
            `offsets=${candidateOffsets(duration).join(',')}`
        );

        const extracted = await withExtractionSlot(async () => {
            // existingMeta was read at dispatch, before this task queued for a slot.
            // A replay or rescan queues several tasks per file, so re-check here —
            // otherwise every duplicate behind the first recomputes the same still.
            if (!forceRecompute && await metaCore.getProperty(cid, 'still')) return 'present' as const;
            if (!forceRecompute && recentlyFailed(cid)) return 'recently-failed' as const;
            const result = await extractStill(input, stream.index, duration);
            if (!result) rememberNoUsableFrame(cid);
            return result;
        });
        if (extracted === 'present') {
            await skip('Still already present');
            return;
        }
        if (extracted === 'recently-failed') {
            // The first attempt already logged "No usable frame".
            await skip('No usable frame (recent attempt, not retried)', true);
            return;
        }
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
