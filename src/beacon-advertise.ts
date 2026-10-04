/**
 * Beacon v2 advertiser — makes this plugin findable by meta-sort's Plugins
 * page (Scan → Add) without anyone typing its URL.
 *
 * Advertises one resource, cap `metamesh.enrich/<manifest id>`, on the beacon
 * group (239.255.99.1:9099): unsolicited every 10 s, and unicast in reply to
 * any probe whose `want` matches. Says `bye` on shutdown. It keeps no view of
 * other nodes — a plugin only needs to be found. Spec:
 * meta-root docs/project-architecture/beacon-v2.md.
 *
 * Env:
 *   ENABLE_UDP_DISCOVERY  false/0/no/off disables
 *   BEACON_ADVERTISE_URL  endpoints.http (default http://$HOSTNAME:$PORT)
 *   BEACON_BINDS          the one meta-sort instance allowed to list it
 *                         (meta-sort sets this on containers it spawns)
 *   BEACON_GROUP / BEACON_PORT / BEACON_INTERVAL_MS
 *
 * ⚠ MIRRORED FILE. Byte-identical copies live in every TypeScript
 * metamesh-plugin-*; see meta-root `scripts/check-mirrors.sh`. Never fatal: a
 * host that blocks multicast logs a warning and the plugin serves on.
 */

import dgram from 'dgram';
import { hostname, networkInterfaces } from 'os';

const PROTO = 'beacon';
const VERSION = 2;

interface Resource {
    id: string;
    caps: string[];
    endpoints: Record<string, string>;
    binds?: string;
}

interface NodeInfo {
    name: string;
    instance: string;
    version?: string;
}

function envNum(key: string): number | undefined {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function enabled(): boolean {
    const v = (process.env.ENABLE_UDP_DISCOVERY ?? '').trim().toLowerCase();
    return !['false', '0', 'no', 'off'].includes(v);
}

/** IPv4 addresses of every up, non-internal interface. */
function interfaceAddresses(): string[] {
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
        for (const ni of list ?? []) {
            const v4 = (ni as { family: string | number }).family === 'IPv4' || (ni as { family: string | number }).family === 4;
            if (v4 && !ni.internal && ni.address) out.push(ni.address);
        }
    }
    return out;
}

/** Same matching rules as the spec: `*`, `x/*`, optional `@contract`. */
function capMatches(pattern: string, cap: string): boolean {
    if (pattern === '*') return true;
    const split = (s: string): [string, string | null] => {
        const i = s.lastIndexOf('@');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, null];
    };
    const [pb, pc] = split(pattern);
    const [cb, cc] = split(cap);
    if (pc !== null && cc !== pc) return false;
    if (pb.endsWith('/*')) {
        const prefix = pb.slice(0, -2);
        const rest = cb.startsWith(prefix) ? cb.slice(prefix.length) : '';
        return rest.startsWith('/') && rest.length > 1;
    }
    return pb === cb;
}

let socket: dgram.Socket | null = null;
let timer: NodeJS.Timeout | null = null;
let node: NodeInfo | null = null;
let resource: Resource | null = null;
let ifaces: string[] = [];
let group = '239.255.99.1';
let udpPort = 9099;

function send(msg: object, dest?: { address: string; port: number }): void {
    const s = socket;
    if (!s) return;
    const body = Buffer.from(JSON.stringify(msg));
    if (dest) {
        s.send(body, dest.port, dest.address, () => {});
        return;
    }
    // Once per interface: the default route alone reaches one network.
    for (const addr of ifaces) {
        try {
            s.setMulticastInterface(addr);
            s.send(body, udpPort, group, () => {});
        } catch (e) {
            console.warn(`[beacon] send on ${addr} failed:`, e);
        }
    }
}

function advertise(dest?: { address: string; port: number }): void {
    if (!node || !resource) return;
    send({ proto: PROTO, v: VERSION, type: 'advertise', node, resources: [resource] }, dest);
}

/**
 * Start advertising this plugin. Call once the HTTP server is listening, so a
 * consumer that hears it can reach it. Idempotent.
 */
export function startBeacon(pluginId: string, version: string, httpPort: number): void {
    if (socket || !enabled()) return;
    group = process.env.BEACON_GROUP || group;
    udpPort = envNum('BEACON_PORT') ?? udpPort;
    const intervalMs = envNum('BEACON_INTERVAL_MS') ?? 10_000;
    const instance = process.env.HOSTNAME || hostname();
    const url = (process.env.BEACON_ADVERTISE_URL || `http://${instance}:${httpPort}`).replace(/\/+$/, '');
    const binds = (process.env.BEACON_BINDS || '').trim();

    node = { name: `metamesh-plugin-${pluginId}`, instance, ...(version ? { version } : {}) };
    resource = {
        id: pluginId,
        caps: [`metamesh.enrich/${pluginId}`],
        endpoints: { http: url, manifest: '/manifest' },
        ...(binds ? { binds } : {}),
    };

    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket = s;
    s.on('error', (err) => console.warn('[beacon] socket error:', err.message));
    s.on('message', (buf, rinfo) => {
        let m: { proto?: string; v?: number; type?: string; from?: string; want?: string[] };
        try {
            m = JSON.parse(buf.toString('utf8'));
        } catch {
            return; // foreign traffic on the shared group
        }
        if (m?.proto !== PROTO || m.v !== VERSION || m.type !== 'probe' || m.from === instance) return;
        const want = Array.isArray(m.want) ? m.want : [];
        if (want.length === 0 || resource!.caps.some((c) => want.some((p) => capMatches(p, c)))) {
            advertise({ address: rinfo.address, port: rinfo.port });
        }
    });
    s.bind(udpPort, '0.0.0.0', () => {
        try {
            s.setMulticastTTL(1);
        } catch {
            /* best effort */
        }
        ifaces = interfaceAddresses();
        for (const addr of ifaces) {
            try {
                s.addMembership(group, addr);
            } catch (e) {
                console.warn(`[beacon] join ${group} on ${addr} failed:`, e);
            }
        }
        console.log(`[beacon] advertising metamesh.enrich/${pluginId} at ${url} on ${group}:${udpPort}`);
        advertise();
        timer = setInterval(() => advertise(), intervalMs);
        timer.unref?.();
    });
}

/** Say `bye` so consumers drop this plugin at once. */
export async function stopBeacon(): Promise<void> {
    if (!socket || !node) return;
    if (timer) clearInterval(timer);
    send({ proto: PROTO, v: VERSION, type: 'bye', node });
    // Let the bye datagrams leave before the socket closes under them.
    await new Promise((r) => setTimeout(r, 50));
    const s = socket;
    socket = null;
    await new Promise<void>((resolve) => {
        try {
            s.close(() => resolve());
        } catch {
            resolve();
        }
    });
}
