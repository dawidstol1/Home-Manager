'use strict';

/**
 * Narzędzia administracyjne z wiersza poleceń (na serwerze):
 *   node src/cli.js reset-password <login>   – ustawia nowe hasło (pyta o nie)
 *   node src/cli.js create-admin <login> <imię> – tworzy konto administratora
 *   node src/cli.js list-users
 * Korzysta z tych samych zmiennych co serwer (DATABASE_URL).
 */

const readline = require('node:readline');
const { Store, DEFAULT_URL } = require('./db');
const { hashPassword } = require('./auth');

/** Pyta o hasło dwa razy (bez wyświetlania wpisywanych znaków w terminalu). */
async function newPassword() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let muted = false;
  if (process.stdin.isTTY) {
    rl._writeToOutput = (s) => {
      if (!muted || s === '\r\n' || s === '\n') rl.output.write(s);
    };
  }
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    muted = false;
    rl.output.write(q);
    muted = true;
    const { value } = await lines.next();
    muted = false;
    if (process.stdin.isTTY) rl.output.write('\n');
    return value ?? '';
  };
  try {
    const p1 = await ask('Nowe hasło (min. 8 znaków): ');
    const p2 = await ask('Powtórz hasło: ');
    if (p1 !== p2) throw new Error('Hasła się różnią');
    return await hashPassword(p1);
  } finally {
    rl.close();
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = await Store.open({ connectionString: process.env.DATABASE_URL || DEFAULT_URL, max: 1 });
  try {
    if (cmd === 'list-users') {
      for (const u of await store.listUsers()) console.log(`${u.id}\t${u.login}\t${u.role}\t${u.name}`);
    } else if (cmd === 'reset-password' && args[0]) {
      const user = await store.findUserForLogin(args[0]);
      if (!user) throw new Error(`Nie ma użytkownika „${args[0]}”`);
      await store.updateUser(user.id, {}, await newPassword());
      await store.deleteUserSessions(user.id);
      console.log(`Hasło użytkownika ${user.login} zostało zmienione.`);
    } else if (cmd === 'create-admin' && args[0]) {
      const user = await store.createUser({ login: args[0], name: args.slice(1).join(' ') || args[0], role: 'admin' }, await newPassword());
      console.log(`Utworzono administratora ${user.login}.`);
    } else {
      console.log('Użycie:\n  node src/cli.js list-users\n  node src/cli.js reset-password <login>\n  node src/cli.js create-admin <login> [imię]');
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
