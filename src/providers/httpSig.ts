/**
 * RFC 9421 HTTP message signatures, as pawaPay signs its callbacks (ECDSA P-256 / P-384). Import-free, so it is unit-tested in plain Node.
 * A callback is accepted only if the body digest matches, the signature covers the method, path and digest, it is fresh, and it verifies against the key.
 */
import { safeEqual } from '../util.ts';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const B64 = (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

export interface SigParams { label: string; components: string[]; raw: string; alg: string; keyid: string; created: number; expires?: number }

/** Parses `Signature-Input: sig-pp=("@method" "content-digest");alg="ecdsa-p256-sha256";keyid="K";created=1;expires=2`. */
export function parseSignatureInput(header: string): SigParams | null {
	const m = /^([A-Za-z0-9_-]+)=\(([^)]*)\)((?:;[^;]+)*)$/.exec(header.trim());
	if (!m) return null;
	const params = Object.fromEntries([...m[3]!.matchAll(/;([a-z]+)=("[^"]*"|\d+)/g)].map((p) => [p[1]!, p[2]!.replace(/^"|"$/g, '')]));
	const components = [...m[2]!.matchAll(/"([^"]+)"/g)].map((c) => c[1]!);
	if (!params.alg || !params.keyid || !params.created || components.length === 0) return null;
	return { label: m[1]!, components, raw: `(${m[2]})${m[3]}`, alg: params.alg, keyid: params.keyid, created: Number(params.created), expires: params.expires ? Number(params.expires) : undefined };
}

/** The signature base: one line per covered component, then the signature parameters. */
export function signatureBase(p: SigParams, req: { method: string; url: URL; headers: Headers }): string | null {
	const lines: string[] = [];
	for (const c of p.components) {
		let v: string | null;
		if (c === '@method') v = req.method.toUpperCase();
		else if (c === '@authority') v = req.url.host.toLowerCase();
		else if (c === '@path') v = req.url.pathname;
		else if (c === '@scheme') v = req.url.protocol.replace(':', '');
		else if (c === '@query') v = req.url.search || '?';
		else if (c === '@target-uri') v = req.url.href;
		else if (c.startsWith('@')) return null; // a derived component we don't implement: refuse rather than guess
		else v = req.headers.get(c);
		if (v === null) return null;
		lines.push(`"${c}": ${v.trim()}`);
	}
	lines.push(`"@signature-params": ${p.raw}`);
	return lines.join('\n');
}

const ALGS: Record<string, { import: { name: string; namedCurve: string }; verify: { name: string; hash: string } }> = {
	'ecdsa-p256-sha256': { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
	'ecdsa-p384-sha384': { import: { name: 'ECDSA', namedCurve: 'P-384' }, verify: { name: 'ECDSA', hash: 'SHA-384' } },
};

/** `Content-Digest: sha-512=:base64:` must match the body. */
export async function digestMatches(header: string | null, body: string): Promise<boolean> {
	const m = /^(sha-256|sha-512)=:([A-Za-z0-9+/=]+):$/.exec((header ?? '').trim());
	if (!m) return false;
	const h = await crypto.subtle.digest(m[1] === 'sha-512' ? 'SHA-512' : 'SHA-256', new TextEncoder().encode(body));
	return safeEqual(B64(new Uint8Array(h)), m[2]!);
}

const pemToDer = (pem: string) => b64(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));

export type KeyFetcher = (keyid: string) => Promise<string | null>;

/**
 * ECDSA signatures come in two encodings: the raw r‖s that RFC 9421 and WebCrypto use, and ASN.1 DER (SEQUENCE { INTEGER r, INTEGER s }), which is
 * what pawaPay actually sends (Java's default; their examples start "MEQCI"/"MEUCI", i.e. 0x30 0x44/0x45). WebCrypto only verifies the raw form,
 * so DER is converted; anything else is returned as it is and simply fails to verify.
 */
export function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array {
	if (sig.length === 2 * size || sig[0] !== 0x30) return sig;
	let i = 2;
	if (sig[1]! & 0x80) i += sig[1]! & 0x7f; // long-form length
	const int = (): Uint8Array | null => {
		if (sig[i] !== 0x02) return null;
		const len = sig[i + 1]!;
		let v = sig.subarray(i + 2, i + 2 + len);
		i += 2 + len;
		while (v.length > size && v[0] === 0) v = v.subarray(1); // a leading 0 keeps the INTEGER positive
		return v.length <= size ? v : null;
	};
	const r = int(), s = int();
	if (!r || !s || i !== sig.length) return sig;
	const out = new Uint8Array(2 * size);
	out.set(r, size - r.length);
	out.set(s, 2 * size - s.length);
	return out;
}

/** Why a callback was refused, or null when it verifies. Only the reason is logged; nothing secret is in it. */
export async function callbackRejection(req: { method: string; url: URL; headers: Headers; body: string }, getKey: KeyFetcher, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<string | null> {
	const sigInput = req.headers.get('signature-input'), sigHeader = req.headers.get('signature');
	if (!sigInput || !sigHeader) return 'missing Signature or Signature-Input';
	const p = parseSignatureInput(sigInput);
	if (!p) return 'unreadable Signature-Input';
	// the body must be covered, or a valid signature could be reused with a different body
	if (!p.components.includes('content-digest') || !p.components.includes('@method') || !p.components.includes('@path')) return 'signature does not cover method, path and digest';
	const alg = ALGS[p.alg];
	if (!alg) return `unsupported alg ${p.alg}`;
	if (Math.abs(nowSeconds - p.created) > toleranceSeconds) return `stale or future signature (created ${p.created}, now ${nowSeconds})`; // replay protection
	if (p.expires !== undefined && nowSeconds > p.expires + 60) return 'signature expired';
	if (!(await digestMatches(req.headers.get('content-digest'), req.body))) return 'Content-Digest does not match the body';
	const sm = new RegExp(`(?:^|,\\s*)${p.label}=:([A-Za-z0-9+/=]+):`).exec(sigHeader);
	if (!sm) return 'no signature for the label';
	const base = signatureBase(p, req);
	if (!base) return 'a covered component is missing';
	const pem = await getKey(p.keyid);
	if (!pem) return `no public key for keyid ${p.keyid}`;
	try {
		const key = await crypto.subtle.importKey('spki', pemToDer(pem), alg.import, false, ['verify']);
		const size = alg.import.namedCurve === 'P-384' ? 48 : 32;
		return (await crypto.subtle.verify(alg.verify, key, ecdsaRaw(b64(sm[1]!), size), new TextEncoder().encode(base))) ? null : 'signature does not verify';
	} catch (e) { return `verification error: ${String(e)}`; }
}

export async function verifyCallback(req: { method: string; url: URL; headers: Headers; body: string }, getKey: KeyFetcher, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
	return (await callbackRejection(req, getKey, nowSeconds, toleranceSeconds)) === null;
}
