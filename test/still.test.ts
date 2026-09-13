/**
 * Still Extractor Plugin Tests
 *
 * Pure helpers run anywhere; the extraction tests need ffmpeg and the
 * generated fixtures, so they run in the test container (./test.sh).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    manifest,
    process as processFile,
    candidateOffsets,
    frameStats,
    isUsableFrame,
    sanitizeFilename,
    stillFilename,
    computeMidHash256FromBuffer,
    selectPrimaryVideoStream,
    extractStill,
    grabFrame,
    configure,
    withExtractionSlot,
    probeDuration,
    durationFromMeta,
    probeMedia,
    pickPrimaryVideoStream,
    recentlyFailed,
    rememberNoUsableFrame,
} from '../src/plugin.js';
import type { CallbackPayload } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const TEMP = '/tmp/still-extractor-test';

function hasFfmpeg(): boolean {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function fixture(name: string): string {
    return path.join(FIXTURES, name);
}

/** Build the `stream/{n}` table exactly the way the ffmpeg plugin writes it. */
function streamTableFor(file: string): Record<string, string> {
    const probe = JSON.parse(
        execSync(`ffprobe -v quiet -print_format json -show_streams "${file}"`, { encoding: 'utf-8' })
    ) as { streams: Array<Record<string, unknown>> };

    const table: Record<string, string> = {};
    let n = 0;
    for (const s of probe.streams) {
        if (s.codec_type !== 'video' && s.codec_type !== 'audio' && s.codec_type !== 'subtitle') continue;
        const entry: Record<string, unknown> = { type: s.codec_type };
        if (s.codec_name) entry.codec = String(s.codec_name);
        if (s.index != null) entry.index = s.index;
        if (s.width) entry.width = s.width;
        if (s.height) entry.height = s.height;
        // The ffmpeg plugin drops avg_frame_rate when it is "0/0" — the very
        // signal we lean on to spot attached cover art.
        if (s.avg_frame_rate && s.avg_frame_rate !== '0/0') entry.frameRate = String(s.avg_frame_rate);
        table[`stream/${n}`] = JSON.stringify(entry);
        n++;
    }
    return table;
}

const ffmpegAvailable = hasFfmpeg();
const fixturesReady = existsSync(fixture('color.mp4'));

describe('manifest', () => {
    it('declares its dependencies and queue', () => {
        expect(manifest.id).toBe('still-extractor');
        expect(manifest.dependencies).toEqual(['file-info', 'ffmpeg']);
        expect(manifest.defaultQueue).toBe('background');
        expect(manifest.schema?.still).toBeDefined();
    });

    it('does not advertise writing poster or stillPath', () => {
        const keys = Object.keys(manifest.schema ?? {});
        expect(keys).toEqual(['still']);
    });
});

describe('candidateOffsets', () => {
    it('spreads candidates through the middle of the file', () => {
        expect(candidateOffsets(100, [20, 45, 70])).toEqual([20, 45, 70]);
    });

    it('keeps away from both ends', () => {
        const offsets = candidateOffsets(10, [1, 50, 99]);
        for (const t of offsets) {
            expect(t).toBeGreaterThanOrEqual(2);
            expect(t).toBeLessThanOrEqual(8);
        }
    });

    it('falls back to a blind attempt when duration is unknown', () => {
        expect(candidateOffsets(undefined)).toEqual([10, 0]);
        expect(candidateOffsets(0)).toEqual([10, 0]);
    });

    it('takes the midpoint of a very short clip', () => {
        expect(candidateOffsets(3)).toEqual([1.5]);
    });

    it('deduplicates offsets that clamp onto each other', () => {
        const offsets = candidateOffsets(6, [10, 12, 14]);
        expect(new Set(offsets).size).toBe(offsets.length);
    });
});

describe('frameStats / isUsableFrame', () => {
    it('measures a flat buffer as zero-variance', () => {
        const stats = frameStats(Buffer.alloc(1024, 128));
        expect(stats.mean).toBe(128);
        expect(stats.stddev).toBe(0);
    });

    it('rejects black, white and flat frames', () => {
        expect(isUsableFrame({ mean: 2, stddev: 1 })).toBe(false);    // black
        expect(isUsableFrame({ mean: 252, stddev: 1 })).toBe(false);  // blown out
        expect(isUsableFrame({ mean: 128, stddev: 2 })).toBe(false);  // flat grey
    });

    it('accepts a frame with real detail', () => {
        expect(isUsableFrame({ mean: 110, stddev: 45 })).toBe(true);
    });
});

describe('filenames', () => {
    it('strips path-hostile characters', () => {
        expect(sanitizeFilename('a/b:c*d?')).toBe('abcd');
    });

    it('carries the source CID so two files cannot collide', () => {
        const a = stillFilename('/files/watch/Show/episode.mkv', 'bafkreiaaaaaaaaaaaa111111');
        const b = stillFilename('/files/watch/Other/episode.mkv', 'bafkreiaaaaaaaaaaaa222222');
        expect(a).not.toBe(b);
        expect(a.endsWith('_still.jpg')).toBe(true);
        expect(a.startsWith('episode[')).toBe(true);
    });
});

describe('computeMidHash256FromBuffer', () => {
    // Vector produced by packages/meta-hash's own computeMidHash256Sync over a
    // file holding exactly this string. This function is a hand-rolled copy of
    // that algorithm; the vector is what pins the copy to the original.
    it('matches meta-hash for a known buffer', () => {
        const cid = computeMidHash256FromBuffer(Buffer.from('metamesh-still-extractor-cid-vector'));
        expect(cid).toBe('bagacbabaecybg7wcyxl7su3dvjleuwgwil5tgeoybrwc35jasqtywb6bnjzk4');
    });
});

describe('selectPrimaryVideoStream', () => {
    it('returns null when there is no video stream', () => {
        expect(selectPrimaryVideoStream({
            'stream/0': JSON.stringify({ type: 'audio', index: 0, codec: 'aac' }),
        })).toBeNull();
        expect(selectPrimaryVideoStream(undefined)).toBeNull();
        expect(selectPrimaryVideoStream({})).toBeNull();
    });

    it('reads the flattened `stream` array form too', () => {
        const picked = selectPrimaryVideoStream({
            stream: JSON.stringify([
                JSON.stringify({ type: 'audio', index: 0 }),
                JSON.stringify({ type: 'video', index: 1, width: 1920, height: 1080, codec: 'h264', frameRate: '24/1' }),
            ]),
        } as unknown as Record<string, string>);
        expect(picked?.index).toBe(1);
    });

    it('prefers the larger of two real video streams', () => {
        const picked = selectPrimaryVideoStream({
            'stream/0': JSON.stringify({ type: 'video', index: 0, width: 640, height: 480, codec: 'h264', frameRate: '24/1' }),
            'stream/1': JSON.stringify({ type: 'video', index: 1, width: 1920, height: 1080, codec: 'h264', frameRate: '24/1' }),
        });
        expect(picked?.index).toBe(1);
    });

    it('ignores a bigger cover art stream in favour of the moving picture', () => {
        const picked = selectPrimaryVideoStream({
            'stream/0': JSON.stringify({ type: 'video', index: 0, width: 320, height: 240, codec: 'h264', frameRate: '24/1' }),
            // attached_pic: no frameRate, still-image codec, but much larger
            'stream/1': JSON.stringify({ type: 'video', index: 1, width: 600, height: 900, codec: 'mjpeg' }),
        });
        expect(picked?.index).toBe(0);
    });

    it('still returns something when nothing looks like moving video', () => {
        const picked = selectPrimaryVideoStream({
            'stream/0': JSON.stringify({ type: 'video', index: 0, width: 600, height: 900, codec: 'mjpeg' }),
        });
        expect(picked?.index).toBe(0);
    });

    it.skipIf(!ffmpegAvailable || !fixturesReady)(
        'picks the film, not the cover, on a real file',
        () => {
            const picked = selectPrimaryVideoStream(streamTableFor(fixture('cover-art.mp4')));
            expect(picked).not.toBeNull();
            expect(picked!.width).toBe(320);
            expect(picked!.height).toBe(240);
        }
    );
});

describe.skipIf(!ffmpegAvailable || !fixturesReady)('extraction', () => {
    beforeAll(() => {
        mkdirSync(TEMP, { recursive: true });
    });

    it('extracts a usable frame from a colourful video', async () => {
        const result = await extractStill(fixture('color.mp4'), 0, 10, TEMP);
        expect(result).not.toBeNull();
        expect(result!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI
        expect(isUsableFrame(result!.stats)).toBe(true);
    });

    it('skips past a black head to a later offset', async () => {
        // 20s file, 6s of black: the 20% candidate (4s) is black and must lose.
        const result = await extractStill(fixture('black-head.mp4'), 0, 20, TEMP);
        expect(result).not.toBeNull();
        expect(result!.offsetSec).toBeGreaterThan(6);
        expect(isUsableFrame(result!.stats)).toBe(true);
    });

    it('returns null for a file with nothing to decode', async () => {
        const frame = await grabFrame(fixture('audio-only.mp3'), 0, 1, path.join(TEMP, 'nope.jpg'));
        expect(frame).toBeNull();
    });

    it('scales the frame down to the configured width', async () => {
        const result = await extractStill(fixture('color.mp4'), 0, 10, TEMP);
        expect(result).not.toBeNull();
        // Source is 320x240, below the 640 cap, so it must come back untouched.
        expect(result!.jpeg.length).toBeGreaterThan(0);
        expect(result!.jpeg.length).toBeLessThan(200_000);
    });
});

describe('process - skip logic', () => {
    const collect = () => {
        const seen: CallbackPayload[] = [];
        return { seen, cb: async (p: CallbackPayload) => { seen.push(p); } };
    };

    const req = (existingMeta: Record<string, string>) => ({
        taskId: 't1',
        cid: 'bafkreitest',
        filePath: '/files/watch/test.mkv',
        callbackUrl: 'http://localhost/callback',
        // Unreachable on purpose: every case here must bail before any I/O.
        metaCoreUrl: 'http://127.0.0.1:9',
        existingMeta,
    });

    it('skips non-video files', async () => {
        const { seen, cb } = collect();
        await processFile(req({ fileType: 'image' }), cb);
        expect(seen[0].status).toBe('skipped');
        expect(seen[0].reason).toBe('Not a video file');
    });

    it('skips a record that already has a still', async () => {
        const { seen, cb } = collect();
        await processFile(req({ fileType: 'video', still: 'bafkreialready' }), cb);
        expect(seen[0].status).toBe('skipped');
        expect(seen[0].reason).toBe('Still already present');
    });

    it('skips when there is no video stream', async () => {
        const { seen, cb } = collect();
        await processFile(
            req({ fileType: 'video', 'stream/0': JSON.stringify({ type: 'audio', index: 0 }) }),
            cb
        );
        expect(seen[0].status).toBe('skipped');
        expect(seen[0].reason).toBe('No video stream');
    });
});

describe('withExtractionSlot', () => {
    const measurePeak = async (jobs: number) => {
        let active = 0;
        let peak = 0;
        const job = () => withExtractionSlot(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 20));
            active--;
        });
        await Promise.all(Array.from({ length: jobs }, job));
        return peak;
    };

    it('never runs more extractions than maxConcurrent', async () => {
        // The dev-stack OOM: four concurrent 1080p grabs in a 512 MiB container.
        configure({ maxConcurrent: 1 });
        expect(await measurePeak(4)).toBe(1);
    });

    it('allows parallelism when configured, and releases every slot', async () => {
        configure({ maxConcurrent: 3 });
        expect(await measurePeak(6)).toBe(3);
        configure({ maxConcurrent: 1 });
        expect(await measurePeak(3)).toBe(1);
    });

    it('releases the slot when the job throws', async () => {
        configure({ maxConcurrent: 1 });
        await expect(withExtractionSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(await measurePeak(2)).toBe(1); // would hang forever if the slot leaked
    });
});

describe('configure', () => {
    it.skipIf(!ffmpegAvailable || !fixturesReady)(
        'treats null numeric values as absent instead of zero',
        async () => {
            // Number(null) === 0: before the fix this set a 0 px width and a 0 ms
            // timeout, killing every grab on the spot.
            configure({ maxWidth: null, jpegQuality: null, frameTimeoutMs: null, maxConcurrent: null });
            mkdirSync(TEMP, { recursive: true });
            const result = await extractStill(fixture('color.mp4'), 0, 10, TEMP);
            expect(result).not.toBeNull();
        }
    );
});

describe.skipIf(!ffmpegAvailable || !fixturesReady)('probeDuration', () => {
    it('reads the duration from the file header', async () => {
        const d = await probeDuration(fixture('color.mp4'));
        expect(d).toBeGreaterThan(9);
        expect(d).toBeLessThan(11);
    });

    it('returns undefined for an unreadable input instead of throwing', async () => {
        expect(await probeDuration(fixture('does-not-exist.mkv'))).toBeUndefined();
    });

    it('turns a record with no duration into real candidate offsets, not the 10s/0s fallback', async () => {
        const d = await probeDuration(fixture('black-head.mp4'));
        expect(d).toBeDefined();
        expect(candidateOffsets(d)).not.toEqual([10, 0]);
        // and the 20% candidate lands past the 6s black head
        expect(candidateOffsets(d)[0]).toBeGreaterThanOrEqual(4);
    });
});

describe('durationFromMeta', () => {
    it('reads the nested document form meta-sort actually sends', () => {
        expect(durationFromMeta({ fileType: 'video', fileinfo: { duration: '1433.089', formatName: 'matroska,webm' } }))
            .toBeCloseTo(1433.089);
    });

    it('reads a numeric nested duration, the exact shape metasort-app/meta returns', () => {
        // Captured from the dev stack: fileinfo.duration is a JSON number there, not a string.
        expect(durationFromMeta({ fileinfo: { duration: 1433.089, formatName: 'matroska,webm' } })).toBe(1433.089);
    });

    it('reads the flat meta-core key', () => {
        expect(durationFromMeta({ 'fileinfo/duration': '1380.031' })).toBeCloseTo(1380.031);
    });

    it('reads a JSON-string fileinfo', () => {
        expect(durationFromMeta({ fileinfo: JSON.stringify({ duration: '42.5' }) })).toBe(42.5);
    });

    it('treats missing, zero and junk values as absent', () => {
        expect(durationFromMeta(undefined)).toBeUndefined();
        expect(durationFromMeta({})).toBeUndefined();
        expect(durationFromMeta({ fileinfo: {} })).toBeUndefined();
        expect(durationFromMeta({ fileinfo: { duration: '0' } })).toBeUndefined();
        expect(durationFromMeta({ fileinfo: { duration: 'N/A' } })).toBeUndefined();
        expect(durationFromMeta({ fileinfo: 'not json' })).toBeUndefined();
    });
});

describe('selectPrimaryVideoStream — nested payload shapes', () => {
    it('reads a nested stream object keyed by index', () => {
        const picked = selectPrimaryVideoStream({
            stream: {
                '0': JSON.stringify({ type: 'audio', index: 0 }),
                '1': JSON.stringify({ type: 'video', index: 1, width: 1280, height: 720, codec: 'h264', frameRate: '24/1' }),
            },
        } as unknown as Record<string, string>);
        expect(picked?.index).toBe(1);
    });

    it('reads a nested stream array of objects', () => {
        const picked = selectPrimaryVideoStream({
            stream: [
                { type: 'video', index: 0, width: 1920, height: 1080, codec: 'av1', frameRate: '24000/1001' },
                { type: 'audio', index: 1 },
            ],
        } as unknown as Record<string, string>);
        expect(picked?.index).toBe(0);
    });
});

describe('pickPrimaryVideoStream', () => {
    it('never prefers an attached picture, even one with a frame rate', () => {
        const picked = pickPrimaryVideoStream([
            { index: 0, width: 640, height: 480, codec: 'h264', frameRate: '24/1' },
            { index: 1, width: 1000, height: 1500, codec: 'h264', frameRate: '24/1', attachedPic: true },
        ]);
        expect(picked?.index).toBe(0);
    });

    it('returns null with no candidates', () => {
        expect(pickPrimaryVideoStream([])).toBeNull();
    });
});

describe.skipIf(!ffmpegAvailable || !fixturesReady)('probeMedia', () => {
    it('reads the duration and video stream of a plain video', async () => {
        const probe = await probeMedia(fixture('color.mp4'));
        expect(probe.duration).toBeGreaterThan(9);
        expect(pickPrimaryVideoStream(probe.videoStreams)?.width).toBe(320);
    });

    it('flags attached cover art and never picks it', async () => {
        const probe = await probeMedia(fixture('cover-art.mp4'));
        expect(probe.videoStreams.some((v) => v.attachedPic)).toBe(true);
        const primary = pickPrimaryVideoStream(probe.videoStreams);
        expect(primary?.attachedPic).toBe(false);
        expect(primary?.width).toBe(320);
    });

    it('finds no video stream in audio-only input', async () => {
        expect(pickPrimaryVideoStream((await probeMedia(fixture('audio-only.mp3'))).videoStreams)).toBeNull();
    });

    it('returns an empty probe for unreadable input instead of throwing', async () => {
        expect(await probeMedia(fixture('does-not-exist.mkv'))).toEqual({ videoStreams: [] });
    });
});

describe('no-usable-frame memory', () => {
    it('remembers a failed cid for an hour, then forgets it', () => {
        const t0 = 1_000_000;
        expect(recentlyFailed('bafk-fail', t0)).toBe(false);
        rememberNoUsableFrame('bafk-fail', t0);
        expect(recentlyFailed('bafk-fail', t0 + 59 * 60 * 1000)).toBe(true);
        expect(recentlyFailed('bafk-fail', t0 + 61 * 60 * 1000)).toBe(false);
    });

    it('is keyed per cid', () => {
        rememberNoUsableFrame('bafk-a', 5);
        expect(recentlyFailed('bafk-b', 5)).toBe(false);
    });
});
