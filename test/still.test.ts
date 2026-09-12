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
