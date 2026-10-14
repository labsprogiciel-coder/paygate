// Paygate operator console. Talks to /admin/* with a Clerk session token when the Worker has Clerk on (it puts the publishable key in a
// <meta>), or with the operator key, which lives in sessionStorage only (gone when the tab closes).
// Everything from the API is rendered with textContent, never as HTML: provider callback bodies are untrusted.

const store = { get: () => { try { return sessionStorage.getItem('pg_admin') } catch { return null } }, set: (v) => { try { v ? sessionStorage.setItem('pg_admin', v) : sessionStorage.removeItem('pg_admin') } catch {} } };
let key = store.get();
const app = document.getElementById('app');
const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || null;
const CLERK = { pk: meta('clerk-publishable-key'), host: meta('clerk-frontend-api') };
let clerk = null; // window.Clerk once loaded

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (v === true) el.setAttribute(k, '');
		else el.setAttribute(k, v);
	}
	for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
	return el;
}

const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));

class AuthError extends Error {}
class NotOperator extends Error { constructor(userId) { super('This account is not an operator'); this.userId = userId } }
const bearer = async () => key || (clerk?.session ? await clerk.session.getToken() : null);
async function api(method, path, body) {
	const res = await fetch(path, { method, headers: { authorization: `Bearer ${await bearer()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new AuthError(data?.error?.message || 'Unauthorized');
	if (res.status === 403 && data?.error?.code === 'not_operator') throw new NotOperator(data.error.userId);
	if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
	return data;
}

const fmtAmount = (n) => n == null ? '–' : `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} FCFA`;
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const ago = (ms) => { if (!ms) return '–'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const PSP = { pawapay: 'pawaPay', pispi: 'PI-SPI', sandbox: 'Sandbox' };
const OPERATOR = { orange: 'Orange Money', wave: 'Wave', moov: 'Moov Money' };
const RAIL = { mobile_money: 'Mobile money', pispi_qr: 'Bank · QR code', pispi_rtp: 'Bank · payment request' };
const ICON = { orange: 'orange', wave: 'wave', moov: 'moov' };
const logoFor = (p) => p.rail === 'mobile_money' ? ICON[p.operator] : p.rail?.startsWith('pispi') ? 'pispi' : null;
/** A payment's provider as an avatar (operator or PI-SPI logo, else the PSP's initials), with a corner badge for its direction. */
const avatar = (p, kind = p.object ?? p.kind) => {
	const f = logoFor(p), out = kind === 'disbursement';
	const name = p.rail === 'mobile_money' ? (OPERATOR[p.operator] || 'Mobile money') : p.rail?.startsWith('pispi') ? 'PI-SPI' : (PSP[p.provider] || p.provider || '');
	return h('span', { class: 'av', title: `${name} · ${out ? 'payout (out)' : 'collection (in)'}` },
		f ? h('img', { src: `/providers/${f}.png`, alt: name, width: 30, height: 30 }) : h('span', { class: 'av-txt' }, (PSP[p.provider] || p.provider || '?').slice(0, 2)),
		h('span', { class: `av-dir ${out ? 'out' : 'in'}`, 'aria-hidden': 'true' }, out ? '↑' : '↓'));
};
const icon = (p) => { const f = p.rail === 'mobile_money' ? ICON[p.operator] : p.rail.startsWith('pispi') ? 'pispi' : null; return f ? h('img', { class: 'logo', src: `/providers/${f}.png`, alt: '', width: 20, height: 20 }) : null; };
const COUNTRY = { CIV: ['ci', "Côte d'Ivoire"], SEN: ['sn', 'Senegal'], BFA: ['bf', 'Burkina Faso'] };
const origin = (p) => { const c = COUNTRY[p.country]; return c ? h('span', { class: 'chan' }, h('img', { class: 'flag', src: `/country/${c[0]}.png`, alt: '', width: 20, height: 20 }), h('span', { title: c[1] }, p.country)) : h('span', { class: 'muted' }, '–'); };
const pspBadge = (p) => h('span', { class: `badge psp psp-${p.provider}` }, PSP[p.provider] || p.provider);
const channel = (p) => p.rail === 'mobile_money' ? (OPERATOR[p.operator] || p.operator || 'Mobile money') : (RAIL[p.rail] || p.rail);
const badge = (s) => h('span', { class: `badge s-${s}` }, s);
const pretty = (t) => { if (!t) return null; try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t } };
const toast = (m) => { const t = h('div', { class: 'toast', role: 'status' }, m); document.body.append(t); setTimeout(() => t.remove(), 2600); };
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied') } catch { toast('Copy failed: select the text instead') } };

// ---- overlays -------------------------------------------------------------------------------------------------------------------
function overlay(content, { center = false } = {}) {
	const box = h('div', { class: center ? 'modal' : 'drawer', role: 'dialog', 'aria-modal': 'true' }, content);
	const ov = h('div', { class: `overlay${center ? ' center' : ''}`, onclick: (e) => { if (e.target === ov) close() } }, box);
	const onKey = (e) => { if (e.key === 'Escape') close() };
	const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) };
	document.addEventListener('keydown', onKey);
	document.body.append(ov);
	box.querySelector('input, textarea, select, button')?.focus();
	return { close, box };
}
function secretModal(title, note, value) {
	const m = overlay([h('h2', {}, title), h('p', { class: 'muted' }, note), h('code', { class: 'secret' }, value),
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => copy(value) }, 'Copy'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'))], { center: true });
}
function confirmModal(title, text, label, onYes) {
	const m = overlay([h('h2', {}, title), h('p', {}, text), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn danger solid', onclick: async (e) => { e.target.disabled = true; try { await onYes(); m.close() } catch (err) { e.target.disabled = false; toast(err.message) } } }, label))], { center: true });
}
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label, hint ? h('small', {}, ` ${hint}`) : null), input);

// ---- login ----------------------------------------------------------------------------------------------------------------------
const loadScript = (src) => new Promise((ok, fail) => document.head.append(h('script', { src, crossorigin: 'anonymous', 'data-clerk-publishable-key': CLERK.pk, onload: ok, onerror: () => fail(new Error(`Could not load ${src}`)) })));
/** Clerk's UI, then Clerk itself, from the Frontend API host the Worker named (the page's CSP allows only that host). */
async function loadClerk() {
	if (clerk) return clerk;
	await loadScript(`https://${CLERK.host}/npm/@clerk/ui@1/dist/ui.browser.js`);
	await loadScript(`https://${CLERK.host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`);
	await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
	return (clerk = window.Clerk);
}
async function signOut(msg) {
	store.set(null); key = null; started = false; location.hash = '';
	if (clerk?.session) await clerk.signOut().catch(() => {});
	login(msg);
}

const login = (msg) => CLERK.pk ? clerkLogin(msg) : keyLogin(msg);

function keyLogin(msg) {
	const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'ADMIN_API_KEY', 'aria-label': 'Operator key' });
	const form = h('form', { class: 'login', onsubmit: async (e) => {
		e.preventDefault(); key = input.value.trim();
		try { await api('GET', '/admin/float'); store.set(key); start() } catch (err) { key = null; keyLogin(err instanceof AuthError ? 'That key was not accepted.' : err.message) }
	} }, h('h1', {}, 'Paygate'), h('p', { class: 'sub' }, 'Operator console. The key stays in this tab only.'), msg ? h('div', { class: 'alert bad' }, msg) : null,
		field('Operator key', input), h('div', { class: 'actions' },
			CLERK.pk ? h('button', { class: 'btn', type: 'button', onclick: () => clerkLogin() }, 'Back') : null,
			h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
	put(app, form); input.focus();
}

async function clerkLogin(msg) {
	const box = h('div', { class: 'clerk' }, h('p', { class: 'muted' }, 'Loading…'));
	put(app, h('div', { class: 'login' }, h('h1', {}, 'Paygate'), h('p', { class: 'sub' }, 'Operator console'), msg ? h('div', { class: 'alert bad' }, msg) : null, box,
		h('p', { class: 'muted small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); keyLogin() } }, 'Use the operator key instead'))));
	try {
		const c = await loadClerk();
		if (c.session) return start();
		box.replaceChildren();
		c.mountSignIn(box, { routing: 'virtual', fallbackRedirectUrl: '/' });
		const off = c.addListener(({ session }) => { if (session && !key) { off(); c.unmountSignIn(box); start() } });
	} catch (err) { put(box, h('div', { class: 'alert bad' }, err.message)) }
}

function notOperator(userId) {
	const id = h('code', { class: 'secret' }, userId || '?');
	put(app, h('div', { class: 'login' }, h('h1', {}, 'Paygate'), h('div', { class: 'alert warn' }, 'You are signed in, but this account is not an operator.'),
		h('p', {}, 'Ask an operator to add your Clerk user id to CLERK_OPERATOR_IDS:'), id,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => copy(userId) }, 'Copy id'), h('button', { class: 'btn primary', onclick: () => signOut() }, 'Sign out'))));
}

// ---- skeletons and paging ----------------------------------------------------------------------------------------------------------
// Placeholders shaped like what is loading, so the page does not jump when it arrives. Widths are classes: the CSP allows no inline styles.
const W = ['w30', 'w60', 'w45', 'w75', 'w40', 'w55', 'w35', 'w65'];
const bar = (i = 0, cls = '') => h('span', { class: `sk ${W[i % W.length]} ${cls}` });
const busy = (...kids) => h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div', { 'aria-hidden': 'true' }, kids));
const skTable = (cols, n = 8) => busy(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
	h('tbody', {}, Array.from({ length: n }, (_, r) => h('tr', { class: 'sk-row' }, cols.map((_, c) => h('td', {}, bar(r + c)))))))));
const skList = (n = 8) => busy(h('div', { class: 'list' }, Array.from({ length: n }, (_, i) => h('div', { class: 'li' }, h('span', { class: 'sk sk-sq' }),
	h('div', { class: 'min0' }, bar(i, 'sk-l'), bar(i + 3, 'sk-s')), h('span', { class: 'sk w-amt' }), h('span', { class: 'sk sk-pill' })))));
const skFeed = (n = 8, compact = false) => busy(h('ul', { class: `feed${compact ? ' compact' : ''}` }, compact ? null : h('li', { class: 'day' }, h('span', { class: 'sk w-day' })),
	Array.from({ length: n }, (_, i) => h('li', { class: 'ev' }, h('span', { class: 'sk w-time' }), h('span', { class: 'sk w-src' }),
		h('div', { class: 'ev-main' }, bar(i + 1, 'sk-l'), bar(i + 4, 'sk-s')), h('span', { class: 'sk sk-pill' })))));
const skTiles = () => busy(h('div', { class: 'tiles' }, [0, 1, 2, 3].map((i) => h('div', { class: 'tile' }, bar(i, 'sk-s'), h('span', { class: 'sk sk-big' }), bar(i + 2, 'sk-s')))));
const skHead = () => busy(h('div', { class: 'bar' }, h('div', { class: 'grow' }, h('span', { class: 'sk sk-h1' }))));
const skDrawer = () => busy(h('div', { class: 'bar' }, h('span', { class: 'sk sk-h1' })), h('div', { class: 'card' }, h('dl', { class: 'kv' },
	Array.from({ length: 8 }, (_, i) => [h('dt', {}, bar(i, 'sk-s')), h('dd', {}, bar(i + 3))]))), h('div', { class: 'card' }, bar(1), bar(4), bar(2)));
const SKELETON = {
	overview: () => [skHead(), skTiles(), h('div', { class: 'cols mt22' }, skList(6), skFeed(6, true))],
	dashboard: () => [skHead(), busy(h('div', { class: 'pgrid' }, [0, 1].map((i) => h('div', { class: 'card pcard' }, h('span', { class: 'sk sk-h1' }), bar(i), bar(i + 3), bar(i + 5), h('span', { class: 'sk sk-big' })))))],
	payments: () => [skHead(), skTable(['When', 'Tenant', 'Type', 'PSP', 'Channel', 'Origin', 'Reference', 'Counterparty', 'Amount', 'Status'], 10)],
	events: () => [skHead(), skFeed(10)],
	tenants: () => [skHead(), skTable(['Id', 'Name', 'Status', 'Webhook', 'Max payment', 'Created'], 5)],
};

const SIZES = [25, 50, 100];
const pref = { get: () => { try { return Number(localStorage.getItem('pg_page_size')) || 50 } catch { return 50 } }, set: (n) => { try { localStorage.setItem('pg_page_size', String(n)) } catch {} } };
/**
 * Cursor paging, newest first. `fetch(cursor, size)` answers { data, next, total? }; Older follows `next`, Newer goes back up the cursors already seen.
 * The page keeps its height while the next one loads (a skeleton of the same number of rows), and scrolls back to the top of the list.
 */
function pager({ fetch, render, skeleton, noun = 'rows' }) {
	const body = h('div'), nav = h('div', { class: 'pager' });
	let stack = [null], size = SIZES.includes(pref.get()) ? pref.get() : 50, last = null, loading = false, seq = 0;
	const sizeSel = h('select', { 'aria-label': `${noun} per page` }, SIZES.map((n) => h('option', { value: n, selected: n === size ? true : null }, `${n} per page`)));
	sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); pref.set(size); reset() });
	const draw = () => {
		const n = last?.data.length ?? 0, from = (stack.length - 1) * size + 1;
		const info = loading ? 'Loading…' : !n ? '' : last.total != null ? `${from}–${from + n - 1} of ${last.total} ${noun}` : `Page ${stack.length}`;
		put(nav, h('span', { class: 'muted small grow', 'aria-live': 'polite' }, info), sizeSel,
			h('button', { class: 'btn sm', disabled: loading || stack.length === 1 ? true : null, onclick: () => { stack.pop(); load(true) } }, '← Newer'),
			h('button', { class: 'btn sm', disabled: loading || !last?.next ? true : null, onclick: () => { stack.push(last.next); load(true) } }, 'Older →'));
	};
	const load = async (scroll = false) => {
		const mine = ++seq; loading = true; draw();
		put(body, skeleton(Math.max(3, Math.min(last?.data.length || 8, size))));
		if (scroll) body.scrollIntoView({ block: 'start', behavior: 'smooth' });
		try { const r = await fetch(stack.at(-1), size); if (mine !== seq) return; last = r; put(body, render(r.data)) }
		catch (e) { if (mine !== seq) return; if (e instanceof AuthError) return signOut('Session ended. Sign in again.'); if (e instanceof NotOperator) return notOperator(e.userId); last = null; put(body, h('div', { class: 'alert bad' }, e.message, ' ', h('button', { class: 'btn sm', onclick: () => load() }, 'Retry'))) }
		loading = false; draw();
	};
	const reset = () => { stack = [null]; last = null; return load() };
	return { el: h('div', {}, body, nav), reset, refresh: () => load() };
}

// ---- shell + router -------------------------------------------------------------------------------------------------------------
const PAGES = { overview: ['Overview', overview], dashboard: ['Dashboard', dashboard], payments: ['Payments', payments], events: ['Events', events], tenants: ['Tenants', tenants] };
let attention = { unknown: 0, problems: 0 };

let started = false;
async function start() {
	if (!key) {
		if (!CLERK.pk) return login();
		const c = await loadClerk().catch(() => null);
		if (!c?.session) return login();
	}
	if (!started) window.addEventListener('hashchange', route);
	started = true;
	route();
}
async function route() {
	document.querySelectorAll('.overlay').forEach((o) => o.remove());
	const name = (location.hash.slice(2) || 'overview').split('?')[0];
	const page = PAGES[name] ? name : 'overview';
	const main = h('main', { class: 'main' }, SKELETON[page]());
	const nav = h('nav', { class: 'nav' }, Object.entries(PAGES).map(([id, [label]]) => {
		const n = id === 'payments' ? attention.unknown : id === 'events' ? attention.problems : 0;
		return h('a', { href: `#/${id}`, 'aria-current': id === page ? 'page' : null }, label, n ? h('span', { class: 'count' }, n) : null);
	}));
	put(app, h('div', { class: 'shell' }, h('aside', { class: 'side' }, h('div', { class: 'brand' }, 'Paygate', h('small', {}, 'Operator console')), nav, h('div', { class: 'spacer' }),
		h('button', { class: 'btn sm', onclick: () => signOut() }, 'Sign out')), main));
	try {
		await PAGES[page][1](main);
		refreshAttention(nav);
	} catch (e) {
		if (e instanceof AuthError) return signOut('Session ended. Sign in again.');
		if (e instanceof NotOperator) return notOperator(e.userId);
		put(main, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: route }, 'Retry'));
	}
}
async function refreshAttention(nav) {
	try {
		const a = await api('GET', '/admin/attention');
		attention = { unknown: a.unknown, problems: a.deadWebhooks + a.rejectedCallbacks24h };
		const set = (id, n) => { const el = [...nav.children].find((x) => x.getAttribute('href') === `#/${id}`); if (!el) return; el.querySelector('.count')?.remove(); if (n) el.append(h('span', { class: 'count' }, n)); };
		set('payments', attention.unknown); set('events', attention.problems);
	} catch { /* the badge is a convenience */ }
}
const head = (title, sub, ...actions) => h('div', { class: 'bar' }, h('div', { class: 'grow' }, h('h1', {}, title), sub ? h('p', { class: 'sub m0' }, sub) : null), actions);
const table = (cols, rows, empty) => rows.length
	? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))), h('tbody', {}, rows)))
	: h('div', { class: 'card empty' }, empty);

// ---- overview -------------------------------------------------------------------------------------------------------------------
const compact = (n) => n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : new Intl.NumberFormat('fr-FR').format(n).replace(/\u202f|\u00a0/g, ' ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tile = (label, value, sub, cls) => h('div', { class: `tile${cls ? ' ' + cls : ''}` }, h('div', { class: 'tl' }, label), h('div', { class: 'tv' }, value), sub ? h('div', { class: 'ts' }, sub) : null);

async function overview(main) {
	const [flt, prov, att, recent, feed] = await Promise.all([api('GET', '/admin/float'), api('GET', '/admin/providers'), api('GET', '/admin/attention'),
		api('GET', '/admin/payments?limit=8'), api('GET', '/admin/events?limit=12')]);

	// what needs a person, most serious first
	const todo = [];
	if (att.unknown) todo.push(['bad', plural(att.unknown, 'payout'), 'with an unknown outcome', 'Money may have been sent. A person must decide.', '#/payments?status=unknown', 'Resolve']);
	if (att.deadWebhooks) todo.push(['warn', plural(att.deadWebhooks, 'webhook'), 'not delivered', 'A product was not told about a payment.', '#/events?source=webhook&problems=1', 'Retry']);
	if (att.rejectedCallbacks24h) todo.push(['warn', plural(att.rejectedCallbacks24h, 'callback'), 'rejected (24 h)', 'Failed the signature or shape check.', '#/events?source=callback&problems=1', 'Inspect']);
	for (const r of flt.rows || []) if (r.status === 'critical' || r.status === 'low') todo.push([r.status === 'critical' ? 'bad' : 'warn', `${r.country} float`, r.status === 'critical' ? 'critical' : 'low', r.reasons.join(' ') || `Below ${fmtAmount(flt.floor)}.`, '#/dashboard', 'View']);
	const attentionBlock = todo.length
		? h('div', { class: 'todo' }, todo.map(([level, what, state, why, href, action]) => h('div', { class: `todo-item ${level}` },
			h('div', { class: 'grow' }, h('strong', {}, what), ` ${state}`, h('div', { class: 'todo-why' }, why)), href ? h('a', { class: 'btn sm', href }, action) : null)))
		: h('div', { class: 'alert ok' }, 'Nothing needs a person right now.');

	// the last 24 hours, every provider together
	const rows = prov.last24h;
	const sum = (f) => rows.filter(f).reduce((a, r) => ({ n: a.n + r.n, amount: a.amount + (r.amount || 0) }), { n: 0, amount: 0 });
	const inn = sum((r) => r.kind === 'collection' && r.status === 'completed'), out = sum((r) => r.kind === 'disbursement' && r.status === 'completed');
	const done = sum((r) => ['completed', 'failed', 'expired'].includes(r.status)), open = sum((r) => r.status === 'processing');
	const rate = done.n ? Math.round(((inn.n + out.n) / done.n) * 100) : null;
	const kpis = h('div', { class: 'tiles' },
		tile('Collected', `${compact(inn.amount)} FCFA`, plural(inn.n, 'payment')),
		tile('Paid out', `${compact(out.amount)} FCFA`, plural(out.n, 'payment')),
		tile('Success rate', rate === null ? '–' : `${rate}%`, done.n ? `${inn.n + out.n} of ${done.n} settled` : 'nothing settled yet'),
		tile('In progress', String(open.n), att.unknown ? `${att.unknown} unknown, needs a person` : 'waiting on customers or providers', att.unknown ? 'bad' : null));

	const sandbox = prov.data.some((p) => p.id === 'sandbox');
	const live = prov.data.some((p) => p.notes.includes('LIVE'));
	put(main,
		head('Overview', null, h('span', { class: `mode ${live ? 's-completed' : sandbox ? 's-low' : 's-idle'}` }, live ? 'Live' : sandbox ? 'Sandbox: no money moves' : 'Not live'), h('button', { class: 'btn', onclick: route }, 'Refresh')),
		attentionBlock,
		h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Last 24 hours')), kpis,
		h('div', { class: 'cols' },
			h('section', {}, h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Latest payments'), h('a', { href: '#/payments' }, 'All payments')), paymentList(recent.data)),
			h('section', {}, h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Latest events'), h('a', { href: '#/events' }, 'All events')), feedList(feed.data, { compact: true }))));
}

/** A short list for the overview; the full table is on the payments page. */
function paymentList(rows) {
	if (!rows.length) return h('div', { class: 'card empty' }, 'No payments yet.');
	return h('div', { class: 'list' }, rows.map((p) => h('div', { class: 'li click', tabindex: 0, onclick: () => paymentDrawer(p.id), onkeydown: (e) => { if (e.key === 'Enter') paymentDrawer(p.id) } },
		avatar(p),
		h('div', { class: 'grow min0' }, h('div', { class: 'ellipsis' }, h('span', { class: 'mono' }, p.reference)), h('div', { class: 'muted small ellipsis' }, p.tenant, ' · ', channel(p), ' · ', ago(p.createdAt))),
		h('span', { class: 'num strong' }, fmtAmount(p.amount)), badge(p.status))));
}

function floatBlock(flt) {
	if (!flt.rows) return null;
	return h('div', { class: 'wallets' }, h('div', { class: 'wl' }, h('span', { class: 'pl' }, 'Payout float'), h('span', { class: 'pl' }, `floor ${fmtAmount(flt.floor)}`)),
		flt.rows.map((r) => h('div', { class: 'wallet' },
			h('span', { class: 'chan' }, COUNTRY[r.country] ? h('img', { class: 'flag', src: `/country/${COUNTRY[r.country][0]}.png`, alt: '', width: 20, height: 20 }) : null, r.country),
			h('span', { class: 'wbal' }, r.balance === null ? 'No wallet' : fmtAmount(r.balance)),
			h('span', { class: 'muted wsub' }, r.coverDays === null ? 'no recent payouts' : `${r.coverDays} days cover`), badge(r.status),
			r.committed ? h('span', { class: 'muted wnote' }, `${fmtAmount(r.committed)} committed (${r.committedCount})`) : null,
			...r.reasons.map((x) => h('span', { class: 'bad-text wnote' }, x)))));
}
// ---- dashboard ------------------------------------------------------------------------------------------------------------------
async function dashboard(main) {
	const [flt, prov] = await Promise.all([api('GET', '/admin/float'), api('GET', '/admin/providers')]);
	put(main, head('Dashboard', `Payment providers, how they are set up, and the payout float (floor ${fmtAmount(flt.floor)}). Figures are for the last 24 hours.`, h('button', { class: 'btn', onclick: route }, 'Refresh')),
		providerCards(prov, flt));
}

function providerCards(prov, flt) {
	return h('div', { class: 'pgrid' }, prov.data.map((p) => {
		const mine = prov.last24h.filter((r) => r.provider === p.id);
		const count = (f) => mine.filter(f).reduce((n, r) => n + r.n, 0);
		const bad = count((r) => r.status === 'failed' || r.status === 'unknown'), open = count((r) => r.status === 'processing');
		const sum = (f) => mine.filter(f).reduce((a, r) => ({ n: a.n + r.n, amount: a.amount + (r.amount || 0) }), { n: 0, amount: 0 });
		const inn = sum((r) => r.kind === 'collection' && r.status === 'completed'), out = sum((r) => r.kind === 'disbursement' && r.status === 'completed');
		const stat = (label, big, small, warn) => h('div', { class: 'pstat' }, h('div', { class: 'pl' }, label), h('div', { class: `pv${warn ? ' bad-text' : ''}` }, big), h('div', { class: 'ps' }, small));
		const mark = p.id === 'pispi' ? h('img', { class: 'pmark', src: '/providers/pispi.png', alt: '', width: 40, height: 40 }) : h('span', { class: 'pmark mono-mark' }, p.id === 'sandbox' ? 'SB' : 'pP');
		return h('section', { class: `card pcard${p.active ? '' : ' off'}` },
			h('header', { class: 'phead' }, mark, h('div', { class: 'grow' }, h('h3', {}, p.name), h('p', { class: 'muted m0' }, p.role)), badge(p.active ? 'active' : 'idle')),
			h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Channels'), h('span', { class: 'chans' }, p.channels.map((c) => h('span', { class: 'chip' }, h('img', { class: 'logo', src: `/providers/${c === 'bank' ? 'pispi' : c}.png`, alt: '', width: 20, height: 20 }), OPERATOR[c] || 'Bank accounts')))),
			h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Countries'), h('span', { class: 'chans' }, p.countries.map((c) => h('span', { class: 'chip' }, COUNTRY[c] ? h('img', { class: 'flag', src: `/country/${COUNTRY[c][0]}.png`, alt: '', width: 20, height: 20 }) : null, COUNTRY[c]?.[1] || c)))),
			p.notes.length ? h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Setup'), h('span', { class: 'chans' }, p.notes.map((n) => h('span', { class: 'tag' }, n)))) : null,
			p.id === flt.provider ? floatBlock(flt) : null,
			mine.length ? h('div', { class: 'pstats' },
				stat('Collected', fmtAmount(inn.amount), plural(inn.n, 'payment')), stat('Paid out', fmtAmount(out.amount), plural(out.n, 'payment')),
				stat('In progress', String(open), 'waiting'), stat('Failed / unknown', String(bad), 'last 24 h', bad > 0)) : h('p', { class: 'muted m0' }, 'No activity in the last 24 hours.'));
	}));
}

// ---- payments -------------------------------------------------------------------------------------------------------------------
function paymentsTable(rows) {
	return table([{ label: 'When' }, { label: 'Tenant' }, { label: 'Type' }, { label: 'PSP' }, { label: 'Channel' }, { label: 'Origin' }, { label: 'Reference' }, { label: 'Counterparty' }, { label: 'Amount', num: true }, { label: 'Status' }],
		rows.map((p) => h('tr', { class: 'click', tabindex: 0, onclick: () => paymentDrawer(p.id), onkeydown: (e) => { if (e.key === 'Enter') paymentDrawer(p.id) } },
			h('td', { title: fmtTime(p.createdAt) }, ago(p.createdAt)), h('td', {}, p.tenant), h('td', {}, p.object === 'collection' ? '↓ in' : '↑ out'), h('td', {}, pspBadge(p)), h('td', {}, h('span', { class: 'chan' }, icon(p), channel(p))), h('td', {}, origin(p)),
			h('td', { class: 'mono' }, p.reference), h('td', { class: 'mono' }, p.counterparty || '–'), h('td', { class: 'num' }, fmtAmount(p.amount)), h('td', {}, badge(p.status)))),
		'No payments match.');
}
async function payments(main) {
	const q = new URLSearchParams(location.hash.split('?')[1] || '');
	const sel = (name, opts) => { const s = h('select', { 'aria-label': name }, opts.map(([v, l]) => h('option', { value: v, selected: q.get(name) === v ? true : null }, l))); return s; };
	const status = sel('status', [['', 'Any status'], ['processing', 'Processing'], ['unknown', 'Unknown'], ['completed', 'Completed'], ['failed', 'Failed'], ['expired', 'Expired']]);
	const kind = sel('kind', [['', 'In and out'], ['collection', 'Collections (in)'], ['disbursement', 'Disbursements (out)']]);
	const tenant = h('input', { placeholder: 'Tenant id', value: q.get('tenant') || '', 'aria-label': 'tenant', size: 14 });
	const find = h('input', { placeholder: 'Find a payment id…', 'aria-label': 'Open payment by id', size: 24 });
	const apply = () => { const p = filters(); history.replaceState(null, '', `#/payments${p.size ? '?' + p : ''}`); load(); };
	for (const el of [status, kind]) el.addEventListener('change', apply);
	tenant.addEventListener('change', apply);
	find.addEventListener('keydown', (e) => { if (e.key === 'Enter' && find.value.trim()) paymentDrawer(find.value.trim()) });
	const filters = () => { const p = new URLSearchParams(); if (status.value) p.set('status', status.value); if (kind.value) p.set('kind', kind.value); if (tenant.value.trim()) p.set('tenant', tenant.value.trim()); return p };
	const list = pager({ noun: 'payments',
		fetch: (before, size) => { const p = filters(); p.set('limit', size); if (before) p.set('before', before); return api('GET', `/admin/payments?${p}`) },
		render: (rows) => paymentsTable(rows),
		skeleton: (n) => skTable(['When', 'Tenant', 'Type', 'PSP', 'Channel', 'Origin', 'Reference', 'Counterparty', 'Amount', 'Status'], n) });
	const load = list.reset;
	put(main, head('Payments', null, h('button', { class: 'btn', onclick: list.refresh }, 'Refresh')), h('div', { class: 'bar' }, status, kind, tenant, h('span', { class: 'grow' }), find), list.el);
	await load();
}
async function paymentDrawer(id) {
	const d = overlay(skDrawer());
	const render = (p) => {
		const resolvable = p.status === 'processing' || p.status === 'unknown' ? ['completed', 'failed'] : p.status === 'failed' || p.status === 'expired' ? ['completed'] : [];
		const row = (k, v) => v == null || v === '' ? null : [h('dt', {}, k), h('dd', {}, v)];
		put(d.box, 
			h('div', { class: 'bar' }, h('h1', { class: 'grow mono t16' }, p.id), badge(p.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			p.status === 'unknown' ? h('div', { class: 'alert bad' }, 'The outcome of this payout is unknown. Check the provider dashboard for the money before deciding.') : null,
			h('div', { class: 'card' }, h('dl', { class: 'kv' },
				row('Tenant', p.tenant), row('Type', p.object), row('Reference', h('span', { class: 'mono' }, p.reference)), row('PSP partner', pspBadge(p)), row(p.rail === 'mobile_money' ? 'Channel (MNO)' : 'Channel', h('span', { class: 'chan' }, icon(p), channel(p))), row('Rail', p.rail), row('Origin', COUNTRY[p.country] ? h('span', { class: 'chan' }, origin(p), COUNTRY[p.country][1]) : null), row('Amount', fmtAmount(p.amount)), row('Counterparty', h('span', { class: 'mono' }, p.counterparty || '')),
				row('PSP payment id', h('span', { class: 'mono' }, p.providerId || '')), row('PSP settlement ref', h('span', { class: 'mono' }, p.providerRef || '')),
				row('Created', fmtTime(p.createdAt)), row('Expires', p.expiresAt ? fmtTime(p.expiresAt) : null), row('Settled', p.settledAt ? fmtTime(p.settledAt) : null), row('Attempts', String(p.attempts)),
				row('Failure shown', p.failure), row('Failure detail', p.failureDetail), row('Metadata', p.metadata ? h('pre', {}, JSON.stringify(p.metadata, null, 2)) : null))),
			resolvable.length ? h('div', { class: 'actions mb16' }, h('button', { class: 'btn primary', onclick: () => resolveModal(p, resolvable, async (np) => { render({ ...np, events: (await api('GET', `/admin/payments/${p.id}`)).events }); }) }, 'Resolve manually…')) : null,
			h('h2', {}, 'History'),
			h('ul', { class: 'timeline' }, p.events.map((e) => h('li', {}, h('strong', {}, e.type), e.type === 'late_completion' ? h('span', { class: 'badge late ml8' }, 'late') : null, ' ', h('span', { class: 'muted' }, `by ${e.actor}`), e.detail ? h('div', {}, e.detail) : null, h('div', { class: 't' }, fmtTime(e.created_at))))));
	};
	try { render(await api('GET', `/admin/payments/${encodeURIComponent(id)}`)) } catch (e) { put(d.box, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function resolveModal(p, outcomes, done) {
	const outcome = h('select', { 'aria-label': 'Outcome' }, outcomes.map((o) => h('option', { value: o }, o === 'completed' ? 'Completed: the money moved' : 'Failed: the money did not move')));
	const note = h('textarea', { rows: 3, maxlength: 300, placeholder: 'What you checked, e.g. "Confirmed in the pawaPay dashboard, payout PAID"' });
	const err = h('div');
	const m = overlay([h('h2', {}, 'Resolve payment'), h('p', { class: 'muted' }, 'This overrides the gateway and notifies the tenant by webhook. It cannot be undone.'),
		field('Outcome', outcome), field('Note', note, '(required, kept in the history)'), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
			h('button', { class: 'btn primary', onclick: async (e) => {
				if (!note.value.trim()) { put(err, h('div', { class: 'alert bad' }, 'A note is required.')); return; }
				e.target.disabled = true;
				try { const np = await api('POST', `/admin/payments/${p.id}/resolve`, { outcome: outcome.value, note: note.value }); m.close(); toast('Resolved'); await done(np); } catch (x) { e.target.disabled = false; put(err, h('div', { class: 'alert bad' }, x.message)); }
			} }, 'Resolve'))], { center: true });
}

// ---- tenants --------------------------------------------------------------------------------------------------------------------
async function tenants(main) {
	const { data } = await api('GET', '/admin/tenants');
	put(main, head('Tenants', 'The products that use this gateway.', h('button', { class: 'btn primary', onclick: () => tenantForm(null, data.map((t) => t.id)) }, 'New tenant')),
		table([{ label: 'Id' }, { label: 'Name' }, { label: 'Status' }, { label: 'Webhook' }, { label: 'Max payment', num: true }, { label: 'Created' }],
			data.map((t) => h('tr', { class: 'click', tabindex: 0, onclick: () => tenantDrawer(t.id), onkeydown: (e) => { if (e.key === 'Enter') tenantDrawer(t.id) } },
				h('td', { class: 'mono' }, t.id), h('td', {}, t.name), h('td', {}, badge(t.status)), h('td', { class: 'mono' }, t.webhook_url || '–'), h('td', { class: 'num' }, t.max_amount ? fmtAmount(t.max_amount) : 'default'), h('td', {}, fmtTime(t.created_at)))),
			'No tenants yet. Create one for each product that will use Paygate.'));
}
const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
/** "Côte Pay Shop" -> "cote-pay-shop": what the server accepts as a tenant id, made unique among `taken`. */
function slugFor(name, taken) {
	const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28).replace(/-+$/, '');
	if (base.length < 2) return '';
	let id = base;
	for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
	return id;
}

function tenantForm(t, taken = []) {
	const f = { id: h('input', { value: t?.id || '', disabled: t ? true : null, placeholder: 'made from the name', pattern: SLUG.source.slice(1, -1), spellcheck: 'false', autocomplete: 'off' }),
		name: h('input', { value: t?.name || '', maxlength: 80, placeholder: t ? null : 'Courtly', autocomplete: 'off' }),
		webhook: h('input', { type: 'url', value: t?.webhook_url || '', placeholder: 'https://example.com/paygate/webhook' }), max: h('input', { type: 'number', min: 100, step: 1, value: t?.max_amount || '', placeholder: 'gateway default' }),
		ns: h('input', { value: '', placeholder: 'leave empty for new products', spellcheck: 'false' }),
		key: h('input', { type: 'checkbox', checked: true }) };
	const err = h('div'), idHint = h('small', { class: 'hint' });
	// the id follows the name until someone types in it
	let idTouched = false;
	const checkId = () => {
		const v = f.id.value.trim();
		put(idHint, !v ? 'Lowercase letters, digits and dashes. It cannot be changed later.' : !SLUG.test(v) ? h('span', { class: 'bad-text' }, 'Start with a letter; 2 to 32 lowercase letters, digits or dashes.')
			: taken.includes(v) ? h('span', { class: 'bad-text' }, 'A tenant already has this id.') : [h('code', {}, v), ' is free. It cannot be changed later.']);
	};
	if (!t) {
		f.name.addEventListener('input', () => { if (!idTouched) { f.id.value = slugFor(f.name.value, taken); checkId() } });
		f.id.addEventListener('input', () => { idTouched = f.id.value !== ''; f.id.value = f.id.value.toLowerCase(); checkId() });
		checkId();
	}
	const save = h('button', { class: 'btn primary', onclick: async (e) => {
		e.target.disabled = true;
		try {
			const max = f.max.value.trim() ? Number(f.max.value) : null, wh = f.webhook.value.trim() || null;
			if (t) { await api('PATCH', `/admin/tenants/${t.id}`, { name: f.name.value, webhookUrl: wh, maxAmount: max }); m.close(); toast('Saved'); route(); return; }
			const id = f.id.value.trim();
			await api('POST', '/admin/tenants', { id, name: f.name.value, webhookUrl: wh, maxAmount: max, idNamespace: f.ns.value.trim() || null });
			m.close(); route();
			if (f.key.checked) await connectModal(id); else tenantDrawer(id);
		} catch (x) { e.target.disabled = false; put(err, h('div', { class: 'alert bad' }, x.message)); }
	} }, t ? 'Save' : 'Create tenant');
	const m = overlay([h('h2', {}, t ? `Edit ${t.id}` : 'New tenant'), field('Name', f.name), t ? null : h('div', { class: 'field' }, h('label', {}, 'Id'), f.id, idHint),
		field('Webhook URL', f.webhook, '(https, can be added later)'), field('Max single payment', f.max, '(FCFA)'),
		t ? null : h('label', { class: 'check mt14' }, f.key, 'Create an API key and show the webhook secret now'),
		t ? null : h('details', { class: 'adv' }, h('summary', {}, 'Advanced'), field('ID namespace', f.ns, '(only for products migrated from another gateway)')), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save)], { center: true });
	f.name.focus();
}

/** Everything a new product needs to connect, in one place: its API key (shown once) and its webhook secret. */
async function connectModal(id) {
	let key, secret;
	try { [key, secret] = await Promise.all([api('POST', `/admin/tenants/${id}/keys`, { label: 'default' }), api('GET', `/admin/tenants/${id}/webhook-secret`)]) }
	catch (x) { toast(`Tenant created, but: ${x.message}`); return tenantDrawer(id) }
	const row = (label, value, note) => [h('label', {}, label, note ? h('small', {}, ` ${note}`) : null), h('div', { class: 'copyrow' }, h('code', { class: 'secret' }, value), h('button', { class: 'btn sm', onclick: () => copy(value) }, 'Copy'))];
	const m = overlay([h('h2', {}, `${id} is ready to connect`), h('p', { class: 'muted' }, 'Give these to the product. The API key is shown only this once: only its hash is stored.'),
		row('API key', key.key, '(Authorization: Bearer …)'), row('Webhook signing secret', secret.secret, '(can be shown again)'),
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { m.close(); tenantDrawer(id) } }, 'Open tenant'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'))], { center: true });
}
async function tenantDrawer(id) {
	const d = overlay(skDrawer());
	const render = async () => {
		const [t, keys] = await Promise.all([api('GET', `/admin/tenants/${id}`), api('GET', `/admin/tenants/${id}/keys`)]);
		put(d.box, 
			h('div', { class: 'bar' }, h('h1', { class: 'grow' }, t.name), badge(t.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'Id'), h('dd', { class: 'mono' }, t.id), h('dt', {}, 'Webhook'), h('dd', { class: 'mono' }, t.webhook_url || '–'), h('dt', {}, 'Max payment'), h('dd', {}, t.max_amount ? fmtAmount(t.max_amount) : 'gateway default'),
				h('dt', {}, 'Secret version'), h('dd', {}, String(t.webhook_version)), h('dt', {}, 'Created'), h('dd', {}, fmtTime(t.created_at)))),
			h('div', { class: 'actions left mb20' },
				h('button', { class: 'btn', onclick: () => tenantForm(t) }, 'Edit'),
				h('button', { class: `btn${t.status === 'active' ? ' danger' : ''}`, onclick: () => {
					const go = async () => { await api('PATCH', `/admin/tenants/${id}`, { status: t.status === 'active' ? 'suspended' : 'active' }); await render(); route(); };
					t.status === 'active' ? confirmModal('Suspend tenant?', `${t.name} will be refused on every API call until you reactivate it. Payments already in flight still settle.`, 'Suspend', go) : go();
				} }, t.status === 'active' ? 'Suspend' : 'Reactivate')),
			h('div', { class: 'bar' }, h('h2', { class: 'grow m0' }, 'API keys'), h('button', { class: 'btn sm primary', onclick: () => newKey(id, render) }, 'New key')),
			table([{ label: 'Key' }, { label: 'Label' }, { label: 'Last used' }, { label: '' }],
				keys.data.map((k) => h('tr', {}, h('td', { class: 'mono' }, `pgk_${k.id}_…`), h('td', {}, k.label || '–'), h('td', {}, k.revoked_at ? badge('dead') : ago(k.last_used_at)),
					h('td', {}, k.revoked_at ? h('span', { class: 'muted' }, 'revoked') : h('button', { class: 'btn sm danger', onclick: () => confirmModal('Revoke key?', `pgk_${k.id}_… stops working immediately. Anything still using it will get 401.`, 'Revoke', async () => { await api('DELETE', `/admin/tenants/${id}/keys/${k.id}`); await render(); }) }, 'Revoke')))),
				'No keys yet.'),
			h('h2', { class: 'mt22' }, 'Webhook signing secret'),
			h('div', { class: 'actions left mt0' },
				h('button', { class: 'btn', onclick: async () => { const s = await api('GET', `/admin/tenants/${id}/webhook-secret`); secretModal(`Webhook secret (v${s.version})`, 'Give this to the product so it can verify webhooks. Treat it like a password.', s.secret); } }, 'Reveal'),
				h('button', { class: 'btn danger', onclick: () => confirmModal('Rotate signing secret?', 'Webhooks are signed with the new secret immediately. The product must update its secret first, or it will reject events.', 'Rotate', async () => { const s = await api('POST', `/admin/tenants/${id}/webhook-secret`); secretModal(`New webhook secret (v${s.version})`, 'Give this to the product now.', s.secret); await render(); }) }, 'Rotate…')));
	};
	try { await render() } catch (e) { put(d.box, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function newKey(tenantId, after) {
	const label = h('input', { maxlength: 80, placeholder: 'e.g. production backend' });
	const m = overlay([h('h2', {}, 'New API key'), field('Label', label, '(optional)'), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn primary', onclick: async (e) => {
			e.target.disabled = true;
			try { const k = await api('POST', `/admin/tenants/${tenantId}/keys`, { label: label.value.trim() || undefined }); m.close(); secretModal('API key created', 'Copy it now. Only its hash is stored, so it cannot be shown again.', k.key); await after(); } catch (x) { e.target.disabled = false; toast(x.message); }
		} }, 'Create'))], { center: true });
}

// ---- failed webhooks ------------------------------------------------------------------------------------------------------------
// ---- events ---------------------------------------------------------------------------------------------------------------------
// One feed: payment status changes, provider callbacks in, webhooks out. Bodies are untrusted and only ever shown as text.
const SOURCE = { payment: ['Payment', '●'], callback: ['Callback in', '↘'], webhook: ['Webhook out', '↗'] };
const dayLabel = (ms) => { const d = new Date(ms), t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
	return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const payLink = (id) => id ? h('a', { class: 'mono', href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); paymentDrawer(id) } }, id) : null;
const who = (actor) => !actor ? null : actor.startsWith('admin:') ? `by operator ${actor.slice(6) === 'operator' ? '(admin key)' : actor.slice(6)}` : `by ${actor}`;

function feedItem(e, { compact = false, onChange } = {}) {
	const [label, glyph] = SOURCE[e.source];
	let title, meta;
	if (e.source === 'payment') {
		title = [`${e.kind === 'disbursement' ? 'Payout' : 'Collection'} ${e.type.replace(/_/g, ' ')}`, e.amount != null ? h('span', { class: 'muted' }, ` · ${fmtAmount(e.amount)}`) : null];
		meta = [e.tenant, payLink(e.paymentId), who(e.actor), e.detail];
	} else if (e.source === 'callback') {
		title = [`${PSP[e.provider] || e.provider} callback `, h('span', { class: 'mono' }, e.type)];
		meta = [e.status === 'accepted' ? 'Signature and shape accepted' : 'Rejected: failed the signature or shape check'];
	} else {
		title = [h('span', { class: 'mono' }, e.type), ` to ${e.tenant}`];
		meta = [payLink(e.paymentId), e.attempts ? plural(e.attempts, 'attempt') : 'not sent yet', e.detail];
	}
	const retry = e.source === 'webhook' && e.status !== 'delivered' && !compact
		? h('button', { class: 'btn sm', onclick: async (ev) => { ev.target.disabled = true; try { await api('POST', `/admin/webhooks/${e.id}/retry`); toast('Queued for delivery'); onChange?.() } catch (x) { ev.target.disabled = false; toast(x.message) } } }, e.status === 'dead' ? 'Retry' : 'Send now')
		: null;
	const body = !compact && e.body ? h('details', { class: 'ev-body' }, h('summary', {}, e.source === 'callback' ? 'Body as received' : 'Payload'), h('pre', {}, pretty(e.body))) : null;
	return h('li', { class: `ev${e.problem ? ' problem' : ''}` },
		h('time', { class: 'ev-time', datetime: new Date(e.at).toISOString(), title: fmtTime(e.at) }, compact ? ago(e.at) : clock(e.at)),
		e.source === 'payment' && compact ? avatar(e) : h('span', { class: `src src-${e.source}`, title: label }, h('span', { 'aria-hidden': 'true' }, glyph), compact ? null : ` ${label}`),
		h('div', { class: 'ev-main' }, h('div', { class: 'ev-title' }, title), h('div', { class: 'ev-meta' }, meta.filter(Boolean).flatMap((m, i) => i ? [' · ', m] : [m])), body),
		h('div', { class: 'ev-side' }, h('span', { class: `badge s-${e.source === 'callback' ? (e.problem ? 'failed' : 'ok') : e.status}` }, e.type === 'late_completion' ? 'late' : e.status.replace(/_/g, ' ')), retry));
}

function feedList(items, opts = {}) {
	if (!items.length) return h('div', { class: 'card empty' }, opts.compact ? 'Nothing has happened yet.' : 'No events match.');
	if (opts.compact) return h('ul', { class: 'feed compact' }, items.map((e) => feedItem(e, opts)));
	const out = []; let day = null;
	for (const e of items) { const d = dayLabel(e.at); if (d !== day) { day = d; out.push(h('li', { class: 'day' }, d)) } out.push(feedItem(e, opts)) }
	return h('ul', { class: 'feed' }, out);
}

async function events(main) {
	const q = new URLSearchParams(location.hash.split('?')[1] || '');
	let source = ['payment', 'callback', 'webhook'].includes(q.get('source')) ? q.get('source') : '';
	const problems = h('input', { type: 'checkbox', checked: q.get('problems') === '1' ? true : null });
	const tenant = h('input', { placeholder: 'Tenant id', value: q.get('tenant') || '', 'aria-label': 'Tenant', size: 12 });
	const payment = h('input', { placeholder: 'Payment id', value: q.get('payment') || '', 'aria-label': 'Payment id', size: 22 });
	const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Source' });
	const drawSeg = () => put(seg, [['', 'All'], ['payment', 'Payments'], ['callback', 'Callbacks in'], ['webhook', 'Webhooks out']].map(([v, l]) =>
		h('button', { type: 'button', 'aria-pressed': String(source === v), onclick: () => { source = v; drawSeg(); apply() } }, l)));
	drawSeg();

	const params = () => { const p = new URLSearchParams(); if (source) p.set('source', source); if (problems.checked) p.set('problems', '1'); if (tenant.value.trim()) p.set('tenant', tenant.value.trim()); if (payment.value.trim()) p.set('payment', payment.value.trim()); return p };
	const list = pager({ noun: 'events',
		fetch: (before, size) => { const p = params(); p.set('limit', size); if (before) p.set('before', before); return api('GET', `/admin/events?${p}`) },
		render: (items) => [source === 'callback' && (tenant.value.trim() || payment.value.trim()) ? h('p', { class: 'muted small' }, 'Provider callbacks belong to no tenant or payment, so those filters hide them.') : null,
			feedList(items, { onChange: () => list.refresh() })],
		skeleton: (n) => skFeed(n) });
	const load = list.reset;
	const apply = () => { const p = params(); history.replaceState(null, '', `#/events${p.size ? '?' + p : ''}`); load(); };
	problems.addEventListener('change', apply); tenant.addEventListener('change', apply); payment.addEventListener('change', apply);

	put(main, head('Events', 'Everything that happened, newest first: payment status changes, provider callbacks in, and webhooks out to products.', h('button', { class: 'btn', onclick: () => list.refresh() }, 'Refresh')),
		h('div', { class: 'bar' }, seg, h('label', { class: 'check' }, problems, 'Needs attention'), h('span', { class: 'grow' }), tenant, payment), list.el);
	await load();
}

start();
