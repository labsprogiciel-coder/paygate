import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LOGO_BYTES } from '../src/tenants.ts';
import { setup } from './helpers/gateway.ts';

const dataUrl = (type: string, bytes: number[], pad = 0) => `data:image/${type};base64,${Buffer.from([...bytes, ...new Array(pad).fill(0)]).toString('base64')}`;
const PNG = dataUrl('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 32);
const WEBP = dataUrl('webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')], 16);

test('a tenant can have a logo: set at creation, changed, removed, and listed with it', async () => {
	const g = await setup();
	const made = await g.admin('POST', '/admin/tenants', { id: 'courtly', name: 'Courtly', logo: PNG });
	assert.equal(made.status, 201);
	assert.equal(made.body.logo, PNG);
	assert.equal((await g.admin('PATCH', '/admin/tenants/courtly', { logo: WEBP })).body.logo, WEBP);
	assert.equal((await g.admin('PATCH', '/admin/tenants/courtly', { name: 'Courtly app' })).body.logo, WEBP, 'other edits leave it alone');
	assert.equal((await g.admin('PATCH', '/admin/tenants/courtly', { logo: null })).body.logo, null);
	const list = (await g.admin('GET', '/admin/tenants')).body.data;
	assert.ok(list.some((t: any) => t.id === 'shop' && t.logo === null));
});

test('only real PNG, JPEG or WebP images within the size limit are accepted', async () => {
	const g = await setup();
	const set = async (logo: unknown) => (await g.admin('PATCH', '/admin/tenants/shop', { logo })).body?.error?.code;
	assert.equal(await set('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='), 'invalid_logo', 'never SVG: it can carry script');
	assert.equal(await set(dataUrl('png', [0xff, 0xd8, 0xff], 16)), 'invalid_logo', 'bytes that are not what the type claims');
	assert.equal(await set('https://example.com/logo.png'), 'invalid_logo', 'a data: URL, not a link');
	assert.equal(await set(`${PNG.slice(0, -4)}!!!!`), 'invalid_logo');
	assert.equal(await set(dataUrl('png', [0x89, 0x50, 0x4e, 0x47], MAX_LOGO_BYTES)), 'logo_too_large');
	assert.equal((await g.admin('GET', '/admin/tenants/shop')).body.logo, null, 'nothing was stored');
	assert.equal((await g.call('PATCH', '/admin/tenants/shop', { logo: PNG })).status, 401, 'a tenant key cannot set it');
});
