'use strict';
/** Przykładowe wpisy w kalendarzu domowym do podglądu i zrzutów ekranu. */
async function seedCalendar(store, { addDays, users }) {
  const [dawid, kasia] = users;
  const add = (data, by = dawid) => store.createEvent(data, { userId: by.id });
  const t = addDays(0);
  const dow = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = poniedziałek
  const monday = addDays(-dow);
  const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  await add({ title: 'Wywóz śmieci – segregowane', starts_on: shift(monday, -28 + 1), repeat: 'weekly', category: 'home', start_time: '06:30' });
  await add({ title: 'Basen – Zosia', starts_on: shift(monday, -14 + 3), repeat: 'weekly', category: 'school', start_time: '17:00', end_time: '18:00', for_users: [kasia.id] }, kasia);
  await add({ title: 'Dentysta – przegląd', starts_on: addDays(2), start_time: '09:30', end_time: '10:15', category: 'health', for_users: [dawid.id], notes: 'ul. Długa 5, gab. 12' });
  await add({ title: 'Zebranie w szkole', starts_on: addDays(4), start_time: '18:00', category: 'school', for_users: [kasia.id] }, kasia);
  await add({ title: 'Czynsz i rachunki', starts_on: `${t.slice(0, 8)}10`, repeat: 'monthly', category: 'home' });
  await add({ title: 'Urodziny babci Heli', starts_on: shift(addDays(9), -365 * 2), repeat: 'yearly', category: 'birthday', notes: 'kupić kwiaty' }, kasia);
  await add({ title: 'Weekend w Zakopanem', starts_on: shift(monday, 18), ends_on: shift(monday, 20), category: 'trip' });
  await add({ title: 'Prezent dla Kasi', starts_on: addDays(6), category: 'family', visibility: 'private' });
  await add({ title: 'Kino – rodzinnie', starts_on: addDays(0), start_time: '19:30', category: 'family' }, kasia);
  await add({ title: 'Delegacja – Poznań', starts_on: addDays(12), ends_on: addDays(13), category: 'work', for_users: [dawid.id] });
}

module.exports = { seedCalendar };
