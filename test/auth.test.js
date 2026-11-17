'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let app;
before(async () => {
  app = await startApp({}, { login: false });
});
after(() => app.close());

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('pierwsze uruchomienie: zakładanie konta administratora tylko raz', async () => {
  assert.equal((await app.raw('GET', '/api/auth/status')).body.setup_required, true);
  assert.equal((await app.raw('GET', '/api/items')).status, 401);

  assert.equal((await app.raw('POST', '/api/auth/setup', { body: { name: 'Ania', login: 'ania', password: 'krótkie' } })).status, 400);
  const setup = await app.raw('POST', '/api/auth/setup', { body: { name: 'Ania', login: 'ania', password: 'dlugiehaslo' } });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.role, 'admin');
  assert.ok(setup.body.token);
  assert.match(setup.headers.get('set-cookie'), /hm_session=.*HttpOnly.*SameSite=Lax/);
  app.token = setup.body.token;

  const again = await app.raw('POST', '/api/auth/setup', { body: { name: 'X', login: 'xxx', password: 'dlugiehaslo' } });
  assert.equal(again.status, 409);
  assert.equal((await app.raw('GET', '/api/auth/status')).body.setup_required, false);
});

test('logowanie hasłem, ciasteczko sesji i wylogowanie', async () => {
  assert.equal((await app.raw('POST', '/api/auth/login', { body: { login: 'ania', password: 'zlehaslo1' } })).status, 401);
  assert.equal((await app.raw('POST', '/api/auth/login', { body: { login: 'nikt', password: 'zlehaslo1' } })).status, 401);
  const ok = await app.raw('POST', '/api/auth/login', { body: { login: 'ANIA', password: 'dlugiehaslo' } });
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);

  const me = await app.raw('GET', '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.body.login, 'ania');

  // Zmiana danych z ciasteczkiem z obcej strony jest blokowana (CSRF).
  const csrf = await app.raw('POST', '/api/categories', { body: { name: 'Obca' }, headers: { Cookie: cookie, Origin: 'https://zla-strona.example' } });
  assert.equal(csrf.status, 403);
  const same = await app.raw('POST', '/api/categories', { body: { name: 'Swoja' }, headers: { Cookie: cookie, Origin: app.base } });
  assert.equal(same.status, 201);

  await app.raw('POST', '/api/auth/logout', { headers: { Cookie: cookie, Origin: app.base } });
  assert.equal((await app.raw('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
});

test('administrator zarządza domownikami; domownik nie ma uprawnień administratora', async () => {
  const created = await app.req('POST', '/api/users', { name: 'Tomek', login: 'tomek', password: 'haslotomka' });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'member');
  assert.equal(created.body.password_hash, undefined);
  assert.equal((await app.req('POST', '/api/users', { name: 'T2', login: 'Tomek', password: 'haslotomka' })).status, 400);

  const tomek = (await app.raw('POST', '/api/auth/login', { body: { login: 'tomek', password: 'haslotomka' } })).body.token;
  assert.equal((await app.raw('GET', '/api/items', { token: tomek })).status, 200);
  assert.equal((await app.raw('POST', '/api/users', { token: tomek, body: { name: 'Z', login: 'zzz', password: 'haslohaslo' } })).status, 403);
  assert.equal((await app.raw('POST', '/api/import', { token: tomek, body: { items: [] } })).status, 403);

  // Historia zapisuje, kto zmienił stan.
  const { body: item } = await app.raw('POST', '/api/items', { token: tomek, body: { name: 'Kawa', quantity: 2 } });
  await app.raw('POST', `/api/items/${item.id}/adjust`, { token: tomek, body: { delta: -1 } });
  const hist = await app.req('GET', `/api/items/${item.id}/history`);
  assert.deepEqual(hist.body.map((h) => h.user_name), ['Tomek', 'Tomek']);

  // Reset hasła przez administratora wylogowuje domownika.
  await app.req('PATCH', `/api/users/${created.body.id}`, { password: 'nowehaslo1' });
  assert.equal((await app.raw('GET', '/api/items', { token: tomek })).status, 401);

  // Nie można usunąć ani zdegradować ostatniego administratora ani siebie.
  assert.equal((await app.req('DELETE', `/api/users/${app.user?.id ?? 1}`)).status, 400);
  assert.equal((await app.req('PATCH', '/api/users/1', { role: 'member' })).status, 400);
  assert.equal((await app.req('DELETE', `/api/users/${created.body.id}`)).status, 204);
});

test('zmiana własnego hasła wymaga obecnego hasła', async () => {
  assert.equal((await app.req('POST', '/api/auth/password', { current_password: 'zle', new_password: 'nowenowe1' })).status, 400);
  assert.equal((await app.req('POST', '/api/auth/password', { current_password: 'dlugiehaslo', new_password: 'nowenowe1' })).status, 200);
  assert.equal((await app.raw('POST', '/api/auth/login', { body: { login: 'ania', password: 'nowenowe1' } })).status, 200);
});

test('blokada po wielu nieudanych logowaniach', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await app.raw('POST', '/api/auth/login', { body: { login: 'ania', password: `zle${i}zle` } });
  }
  assert.equal(last.status, 429);
});
