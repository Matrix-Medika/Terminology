import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBidi,
  detectPatient,
  detectProcedure,
  detectFindings,
  buildLocalAnalysis,
} from '../server.js';

const sample = `
מכון MRI
הנדון: ישראלי, דניאל, ת.ז: 123456789 תאריך לידה: 08/02/1965
הבדיקה בוצעה בתאריך: 02/09/2025
להלן ממצאי בדיקת MRI של ע"ש צווארי
הבדיקה בוצעה ברצפי TSE במישורים השונים, כולל דיכוי שומן.
התוויה קלינית: בירור תלונות רדיקולריות דו"צ.
ממצאים:
היצרות מתונה של תעלת השדרה הצווארית בחלקה התחתון בגובה C5 ומטה.
לחץ דיסקלי על החוט בגבהים C5-C6, C6-C7 עם עדות לשינויי אות מיאלופתיים.
C4-C5: בלט דיסק דיפוזי עם לחץ על השק התקאלי ועל השורשים בתעלה.
C5-C6: היצרות משמעותית של הנקבים.
סיכום:
יישור הלורדוזה.
היצרות בתעלה, בפרט בחלקה התחתון.
שינויים ניווניים דיסקליים ופורמינליים עם אפקט רדיקולרי דו"צ.
בברכה,
ד"ר לוי יעקב
מומחה לרדיולוגיה אבחנתית
מסמך זה נחתם אלקטרונית
`;

test('normalizes bidi and whitespace without losing Hebrew', () => {
  const value = cleanBidi('\u202b MRI \u202c  ע"ש   צווארי');
  assert.equal(value, 'MRI ע"ש צווארי');
});

test('extracts patient identifiers from subject line', () => {
  const patient = detectPatient(sample);
  assert.equal(patient.name, 'דניאל ישראלי');
  assert.equal(patient.id, '123456789');
  assert.equal(patient.birthDate, '08/02/1965');
});

test('recognizes cervical MRI and never falls back to brain', () => {
  const procedure = detectProcedure(sample);
  assert.equal(procedure.modality, 'MRI');
  assert.equal(procedure.bodyRegion, 'cervical_spine');
  assert.equal(procedure.anatomicalSite, 'עמוד שדרה צווארי');
  assert.equal(procedure.performed, true);
  assert.equal(procedure.signed, true);
});

test('does not infer contrast when it is not documented', () => {
  const procedure = detectProcedure(sample);
  assert.equal(procedure.contrast, 'לא תועד');
});

test('extracts clinical findings before coding', () => {
  const findings = detectFindings(sample);
  const labels = findings.map((item) => item.label);
  assert.ok(labels.includes('היצרות תעלת השדרה הצווארית'));
  assert.ok(labels.includes('שינויים מיאלופתיים'));
  assert.ok(labels.includes('שינויים ניווניים דיסקליים'));
  assert.ok(labels.includes('אפקט רדיקולרי דו־צדדי'));
});

test('maps cervical MRI only after facts are resolved', () => {
  const analysis = buildLocalAnalysis(sample, 'mri-cervical.pdf');
  assert.equal(analysis.terminology.procedure.icd9.code, '88.93');
  assert.equal(analysis.terminology.procedure.snomed.code, '241646009');
  assert.equal(analysis.terminology.procedure.billing.code, 'L0444');
  assert.equal(analysis.billing.eligible, true);
  assert.ok(analysis.confidence >= 90);
});

test('does not invent a billable procedure from findings-only text', () => {
  const analysis = buildLocalAnalysis('היצרות תעלת השדרה הצווארית. מומלץ MRI.', 'note.txt');
  assert.equal(analysis.procedure.performed, false);
  assert.equal(analysis.billing.eligible, false);
  assert.equal(analysis.terminology.procedure.billing.code, null);
});

test('result UI follows facts → findings → codes → billing and has no sidebar', async () => {
  const html = await (await import('node:fs/promises')).readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const facts = html.indexOf('id="factsSection"');
  const findings = html.indexOf('id="findingsSection"');
  const terminology = html.indexOf('id="terminologySection"');
  const billing = html.indexOf('id="billingSection"');
  assert.ok(facts > -1 && findings > facts && terminology > findings && billing > terminology);
  assert.equal(/sidebar|dashboard|revenue dashboard/i.test(html), false);
});

test('advanced mappings and technical details are collapsed by default', async () => {
  const html = await (await import('node:fs/promises')).readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(/<details[^>]*\sopen(?:\s|>)/i.test(html), false);
});
