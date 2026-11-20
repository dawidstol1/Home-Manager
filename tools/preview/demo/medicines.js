'use strict';
/** Przykładowa domowa apteczka do podglądu i zrzutów ekranu. */
async function seedMedicines(store, { addDays, users }) {
  const [dawid, kasia] = users;
  const add = (data, opts) => store.createMedicine(data, { userId: (opts?.by ?? dawid).id });

  const para = await add({
    name: 'Paracetamol', substance: 'paracetamol', strength: '500 mg', form: 'tabletki', unit: 'tabl.',
    purpose: 'ból, gorączka, ból głowy', person: 'Dorośli', kit: 'Apteczka w łazience', min_quantity: 6,
    quantity: 20, expires_at: addDays(420), dosage: '1–2 tabl. co 4–6 h, maks. 8 tabl. na dobę',
  });
  await store.takeMedicine(para.id, { amount: 2, person: 'Dawid', note: 'ból głowy' }, { userId: dawid.id });

  const ibu = await add({
    name: 'Ibuprom dla dzieci Forte', substance: 'ibuprofen', strength: '200 mg/5 ml', form: 'zawiesina', unit: 'ml',
    purpose: 'gorączka, ból zęba, ból ucha', person: 'Zosia', kit: 'Kuchnia – górna szafka', min_quantity: 30,
    after_opening_days: 180, quantity: 100, expires_at: addDays(300),
    dosage: '5 ml co 6–8 h (dziecko 15 kg), maks. 3 razy na dobę',
  });
  await store.takeMedicine(ibu.id, { amount: 5, person: 'Zosia', note: 'gorączka 38,4°C' }, { userId: kasia.id });
  await store.q(`UPDATE medicine_log SET created_at = now() - interval '2 hours 20 minutes' WHERE medicine_id = $1`, [ibu.id]);

  const nasal = await add({
    name: 'Xylometazolin WZF 0,05%', substance: 'ksylometazolina', form: 'krople', unit: 'ml', strength: '0,05%',
    purpose: 'katar, zatkany nos', person: 'Zosia', kit: 'Apteczka w łazience', after_opening_days: 28,
  });
  await store.addMedicinePack(nasal.id, { quantity: 6, expires_at: addDays(200), opened_at: addDays(-35) });
  await store.addMedicinePack(nasal.id, { quantity: 10, expires_at: addDays(18) });

  await add({
    name: 'Bepanthen Baby', substance: 'dekspantenol', form: 'maść', unit: 'g', strength: '5%',
    purpose: 'odparzenia, skóra', person: 'Zosia', kit: 'Pokój Zosi', quantity: 30, expires_at: addDays(-20),
  });
  await add({
    name: 'Rutinoscorbin', substance: 'rutozyd + kwas askorbinowy', form: 'tabletki', unit: 'tabl.',
    purpose: 'odporność, przeziębienie', person: 'Wszyscy', kit: 'Kuchnia – górna szafka', min_quantity: 30,
    quantity: 22, expires_at: addDays(150),
  }, { by: kasia });
  await add({
    name: 'Amoksiklav', substance: 'amoksycylina + kwas klawulanowy', form: 'tabletki', unit: 'tabl.', strength: '875 mg',
    purpose: 'antybiotyk – tylko z zalecenia lekarza', person: 'Dawid', kit: 'Apteczka w łazience', prescription: true,
    quantity: 4, expires_at: addDays(25), dosage: '1 tabl. co 12 h przez 7 dni',
  });
  await add({
    name: 'Plastry z opatrunkiem', form: 'plastry', unit: 'szt.', purpose: 'skaleczenia', person: 'Wszyscy',
    kit: 'Apteczka samochodowa', min_quantity: 10, quantity: 8,
  });
  await add({
    name: 'Ventolin', substance: 'salbutamol', form: 'aerozol', unit: 'dawki', strength: '100 µg/dawkę',
    purpose: 'duszność, astma', person: 'Kasia', kit: 'Torebka Kasi', prescription: true, quantity: 160, expires_at: addDays(500),
  }, { by: kasia });
}

module.exports = { seedMedicines };
