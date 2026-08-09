import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBidi,
  detectPatient,
  detectProcedure,
  detectFindings,
  findingTerminology,
  sameSentence,
  buildLocalAnalysis,
  getAiConfig,
  bedrockConverseUrl,
  buildBedrockRequest,
  isDebuggingMode,
  createTelemetry,
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
  const { icd9 } = analysis.terminology.procedure;
  assert.equal(icd9.code, '88.93');
  // The code is retrieved from the catalog, so it must be offered as a candidate
  // for review rather than presented as a settled decision.
  assert.equal(icd9.status, 'candidate');
  assert.match(icd9.source, /ICD-9-CM/);
  assert.ok(icd9.candidates.length > 1, 'a coder needs alternatives to choose from');
  assert.ok(icd9.candidates.some((candidate) => candidate.code === '88.93'));
  assert.ok(analysis.confidence >= 90);
});

test('systems that are not licensed here are reported as missing, not as codes', () => {
  // SNOMED CT needs a member-country licence and the MoH tariff is not
  // published openly, so neither catalog is loaded. Emitting a plausible-looking
  // code for either would be a fabrication a biller might actually submit.
  const analysis = buildLocalAnalysis(sample, 'mri-cervical.pdf');
  const { snomed, billing } = analysis.terminology.procedure;
  assert.equal(snomed.code, null);
  assert.equal(snomed.status, 'unavailable');
  assert.equal(billing.code, null);
  assert.equal(billing.status, 'unavailable');
  // Without a service code nothing is billable, however complete the report is.
  assert.equal(analysis.billing.eligible, false);
  assert.equal(analysis.billing.performanceDocumented, true);
  assert.ok(analysis.billing.warnings.some((warning) => /מחירון/.test(warning)));
});

test('does not invent a billable procedure from findings-only text', () => {
  const analysis = buildLocalAnalysis('היצרות תעלת השדרה הצווארית. מומלץ MRI.', 'note.txt');
  assert.equal(analysis.procedure.performed, false);
  assert.equal(analysis.billing.eligible, false);
  assert.equal(analysis.billing.performanceDocumented, false);
  assert.equal(analysis.terminology.procedure.billing.code, null);
});

test('findings carry diagnosis candidates retrieved from the catalog', () => {
  const analysis = buildLocalAnalysis(sample, 'mri-cervical.pdf');
  const stenosis = analysis.terminology.findings.find((item) => item.findingKey === 'cervical_stenosis');
  assert.equal(stenosis.icd9.code, '723.0');
  assert.equal(stenosis.icd9.status, 'candidate');
  // The evidence travels with the code so the coder can check the sentence that
  // justified it without reopening the document.
  assert.match(stenosis.evidence, /היצרות/);
  for (const mapping of analysis.terminology.findings) {
    assert.equal(mapping.snomed.code, null);
  }
});

test('broad imaging is covered beyond the one hardcoded cervical case', () => {
  const cases = [
    ['בדיקת CT של הבטן בוצעה בתאריך: 01/03/2026', 'CT', 'abdomen', '88.01'],
    ['אולטרסאונד בטן בוצע בתאריך: 01/03/2026', 'US', 'abdomen', '88.76'],
    ['צילום חזה בוצע בתאריך: 01/03/2026', 'XRAY', 'chest', '87.44'],
    ['בדיקת MRI של המוח בוצעה בתאריך: 01/03/2026', 'MRI', 'brain', '88.91'],
    ['ממוגרפיה בוצעה בתאריך: 01/03/2026', 'MAMMO', 'breast', '87.37'],
  ];
  for (const [text, modality, region, expected] of cases) {
    const analysis = buildLocalAnalysis(text, 'study.txt');
    assert.equal(analysis.procedure.modality, modality, text);
    assert.equal(analysis.procedure.bodyRegion, region, text);
    assert.equal(analysis.terminology.procedure.icd9.code, expected,
      `${text} -> ${analysis.terminology.procedure.icd9.code}`);
  }
});

test('no procedure code is offered for a study that was not performed', () => {
  // A referral names a modality and a body part, so retrieval will happily find
  // 88.01 for it. Coding a study that never happened is the worst failure this
  // tool can have, so the code is withheld until performance is documented.
  const analysis = buildLocalAnalysis('מומלץ לבצע CT בטן. טרם בוצע.', 'referral.txt');
  assert.equal(analysis.procedure.modality, 'CT');
  assert.equal(analysis.procedure.performed, false);
  assert.equal(analysis.terminology.procedure.icd9.code, null);
  assert.equal(analysis.terminology.procedure.icd9.status, 'not_performed');
});

test('performance is recognized without the exact phrase "הבדיקה בוצעה"', () => {
  // Reports write "בדיקת CT של הבטן בוצעה בתאריך" just as often, and treating
  // that as unperformed suppressed a code that was legitimately due.
  const procedure = detectProcedure('בדיקת CT של הבטן בוצעה בתאריך: 01/03/2026');
  assert.equal(procedure.performed, true);
});

test('an undocumented qualifier is not added to a diagnosis code', () => {
  // ICD-9 lists "calculus of gallbladder with other cholecystitis, with
  // obstruction" and BM25 ranks it above the plain form, because the qualifiers
  // add matchable words. Submitting a comorbidity the report never mentioned is
  // a coding error, so the "without mention of" sibling has to win.
  const analysis = buildLocalAnalysis(
    'בדיקת CT בטן בוצעה בתאריך: 01/03/2026\nאבנים בכיס המרה.\nמסמך זה נחתם אלקטרונית',
    'ct.txt',
  );
  const stones = analysis.terminology.findings.find((item) => item.findingKey === 'cholelithiasis');
  assert.equal(stones.icd9.code, '574.20');
  assert.match(stones.icd9.display, /without mention of cholecystitis, without mention of obstruction/);
});

test('a mass is coded to the site the study examined, or not at all', () => {
  // "mass" alone retrieved "379.92 Swelling or mass of eye" for a brain study,
  // because ICD-9 files masses by site and the finding carries no site itself.
  const brain = buildLocalAnalysis(
    'בדיקת MRI מוח בוצעה בתאריך: 01/03/2026\nגוש בהמיספרה השמאלית.\nמסמך זה נחתם אלקטרונית',
    'mri.txt',
  );
  const mass = brain.terminology.findings.find((item) => item.findingKey === 'mass_lesion');
  assert.equal(mass.icd9.code, '784.2');
  assert.match(mass.icd9.display, /head and neck/);

  // With no anatomy resolved there is no defensible site, so no code is offered.
  const siteless = findingTerminology([{ key: 'mass_lesion', label: 'גוש', evidence: 'גוש' }], null);
  assert.equal(siteless[0].icd9.code, null);
  assert.match(siteless[0].icd9.display, /נדרשת אנטומיה/);
});

test('an imaging report is not coded to a pathogen it cannot identify', () => {
  // Searching "pneumonia" surfaced anthrax and aspergillosis pneumonia. Imaging
  // shows an infiltrate; it cannot establish the organism.
  const analysis = buildLocalAnalysis(
    'צילום חזה בוצע בתאריך: 01/03/2026\nתסנין בריאה הימנית.\nמסמך זה נחתם אלקטרונית',
    'xray.txt',
  );
  const infiltrate = analysis.terminology.findings.find((item) => item.findingKey === 'pulmonary_infiltrate');
  // The offered code must be organism-neutral. Organism-specific codes may still
  // appear further down the list — a coder with a culture result may need them —
  // but they must not outrank the code the imaging alone supports.
  const organismSpecific = /anthrax|aspergillosis|adenovirus|pseudomonas|pneumococcal|due to/i;
  assert.equal(organismSpecific.test(infiltrate.icd9.display), false, infiltrate.icd9.display);
  const codes = infiltrate.icd9.candidates.map((candidate) => candidate.code);
  const neutral = codes.findIndex((code) => code === '486' || code.startsWith('793.1'));
  const specific = infiltrate.icd9.candidates.findIndex((candidate) => organismSpecific.test(candidate.display));
  assert.ok(neutral > -1, `no organism-neutral code offered: ${codes.join(' ')}`);
  assert.ok(specific === -1 || neutral < specific,
    `an organism-specific code outranked the neutral one: ${codes.join(' ')}`);
});

test('Hebrew word boundaries are matched despite JavaScript \\b being ASCII-only', () => {
  // /\bבטן\b/ can never match, because a Hebrew letter is not an ASCII word
  // character — this silently disabled every Hebrew anatomy pattern.
  assert.equal(detectProcedure('בדיקת CT בטן בוצעה בתאריך: 01/03/2026').bodyRegion, 'abdomen');
  // The prefix cluster must accept the attached article and prepositions...
  assert.equal(detectProcedure('בדיקת CT של הבטן בוצעה בתאריך: 01/03/2026').bodyRegion, 'abdomen');
  // ...without letting שד (breast) match שדרה (spine).
  assert.equal(detectProcedure('MRI ע"ש צווארי בוצע בתאריך: 01/03/2026').bodyRegion, 'cervical_spine');
});

test('a paraphrased AI finding is recognized as the same observation', () => {
  // The model reported "כבד מוגדל (הפטומגליה)" for the same sentence the local
  // parser had captured as "הגדלת כבד". Exact-label dedup let both through, and
  // one observation would have been billed as two diagnoses. The evidence
  // quotation is what identifies the observation, and the model usually quotes a
  // sub-span of the line the parser kept.
  assert.equal(sameSentence('כבד מוגדל. אבנים בכיס המרה.', 'כבד מוגדל'), true);
  assert.equal(sameSentence('כבד מוגדל.', 'כבד מוגדל'), true);
  // Distinct observations on the same line must stay distinct.
  assert.equal(sameSentence('כבד מוגדל', 'אבנים בכיס המרה'), false);
  assert.equal(sameSentence('', 'כבד מוגדל'), false);
});

test('the letterhead does not override the modality of the actual study', () => {
  // An imaging centre's letterhead names its equipment. Scanning the whole
  // document equally let "מכון MRI" outvote the study line, and a CT of the
  // abdomen was coded 88.97, MRI of unspecified site.
  const analysis = buildLocalAnalysis(
    'מכון MRI\nבדיקת CT של הבטן בוצעה בתאריך: 01/03/2026\nמסמך זה נחתם אלקטרונית',
    'ct.txt',
  );
  assert.equal(analysis.procedure.modality, 'CT');
  assert.equal(analysis.terminology.procedure.icd9.code, '88.01');
});

test('a spinal study is never reclassified as a brain study', () => {
  // Hebrew calls the spinal cord "מוח השדרה", so a loose brain pattern would
  // turn a spine MRI into a head MRI — the error this pipeline must prevent.
  const procedure = detectProcedure('MRI ע"ש צווארי. לחץ על מוח השדרה בגובה C5.');
  assert.equal(procedure.bodyRegion, 'cervical_spine');
});

test('a finding the report rules out is never coded', () => {
  // A radiology report states what it excluded as often as what it found, and to
  // a pattern matcher "אין עדות לשבר" contains שבר. Findings are checked into the
  // coding worksheet by default, so an unfiltered match becomes a diagnosis
  // billed against a document that explicitly denies it.
  const denials = [
    ['אין עדות לשבר.', 'שבר'],
    ['ללא גוש בכבד.', 'נגע חשוד / גוש'],
    ['לא נראית פריצת דיסק.', 'פריצת דיסק'],
    ['ללא תפליט פלאורלי.', 'תפליט פלאורלי'],
  ];
  for (const [text, absent] of denials) {
    const labels = detectFindings(text).map((finding) => finding.label);
    assert.equal(labels.includes(absent), false, `${text} -> ${labels.join(' | ')}`);
  }
  // A recommendation is a plan, and history is a previous event; neither is a
  // finding of this study.
  assert.deepEqual(detectFindings('מומלץ CT לשלילת ציסטה בכליה.'), []);
  assert.deepEqual(detectFindings('רקע: עבר שבר באגן ב-2019.'), []);
});

test('the negation filter does not suppress findings the report asserts', () => {
  // The filter has to be scoped to the clause: a denial in one clause must not
  // delete an affirmed finding in the next, and "ללא ממצא פתולוגי" is itself an
  // absence statement, so it has to survive its own filter.
  const affirmed = [
    ['גוש בהמיספרה השמאלית.', 'נגע חשוד / גוש'],
    ['שבר בצוואר הירך.', 'שבר'],
    ['ללא תפליט פלאורלי, קיים גוש בריאה הימנית.', 'נגע חשוד / גוש'],
    ['אין עדות לשבר. נראית ציסטה בכליה.', 'ציסטה'],
    ['ללא ממצא פתולוגי.', 'ללא ממצא פתולוגי'],
  ];
  for (const [text, expected] of affirmed) {
    const labels = detectFindings(text).map((finding) => finding.label);
    assert.ok(labels.includes(expected), `${text} -> ${labels.join(' | ') || '(none)'}`);
  }
});

test('a denial later in the clause does not erase the finding stated before it', () => {
  // Radiologists routinely affirm and exclude in one breath: "אבנים בכיס המרה
  // ללא עדות לדלקת" bills the stones and denies only the cholecystitis. Treating
  // ללא as a whole-clause veto dropped the finding the study was positive for,
  // which loses billable work and is exactly the error a coder cannot see.
  const affirmedThenDenied = [
    ['אבנים בכיס המרה ללא עדות לדלקת.', 'אבנים בכיס המרה'],
    ['כבד מוגדל ללא נגעים מוקדיים.', 'הגדלת כבד'],
    ['תפליט פלאורלי מימין ללא תסנין.', 'תפליט פלאורלי'],
  ];
  for (const [text, expected] of affirmedThenDenied) {
    const labels = detectFindings(text).map((finding) => finding.label);
    assert.ok(labels.includes(expected), `${text} -> ${labels.join(' | ') || '(none)'}`);
  }

  // The mirror image still has to be suppressed: when the cue precedes the
  // finding it governs it, and a verb form denies its clause from either side.
  for (const text of ['ללא עדות לאבנים בכיס המרה.', 'תפליט פלאורלי נשלל.', 'לא נראה תפליט פלאורלי.']) {
    assert.deepEqual(detectFindings(text).map((finding) => finding.label), [], text);
  }
});

test('a Hebrew prefix is not read off the front of the word itself', () => {
  // [הובלמשכ]{0,2} also matches two letters belonging to the word: in בשלב
  // ("at the stage") it consumed בש and the remaining לב matched the heart
  // pattern, so a knee MRI whose report said "בשלב זה אין קרע" was coded 88.92,
  // MRI of chest and myocardium — presented as a decisive match.
  const collisions = [
    ['בשלב זה אין קרע.', 'heart'],
    ['בעצם הירך.', null],
    ['שינויי אות בלשד העצמות.', 'breast'],
    ['מחזה קליני.', 'chest'],
    ['משבר במצב הקליני.', null],
  ];
  for (const [sentence, forbidden] of collisions) {
    const region = detectProcedure(`בדיקת MRI של הברך בוצעה בתאריך: 01/03/2026\n${sentence}`).bodyRegion;
    assert.equal(region, 'musculoskeletal', `${sentence} -> ${region}`);
    if (forbidden) assert.notEqual(region, forbidden);
  }
  // The legitimate prefixed forms must still match.
  assert.equal(detectProcedure('בדיקת CT של הבטן בוצעה בתאריך: 01/03/2026').bodyRegion, 'abdomen');
  assert.equal(detectProcedure('אולטרסאונד לב בוצע בתאריך: 01/03/2026').bodyRegion, 'heart');
});

test('a comparison with a prior study does not set the modality', () => {
  // Radiologists compare against priors constantly, and "בהשוואה לבדיקת CT
  // קודמת" is itself a study declaration — so it outvoted the study actually
  // performed. This is more common in real reports than the letterhead the
  // declaration logic was written to defeat.
  const ultrasound = detectProcedure(
    'אולטרסאונד בטן בוצע בתאריך: 01/03/2026\nבהשוואה לבדיקת CT קודמת מ-2024.',
  );
  assert.equal(ultrasound.modality, 'US');

  // The anatomy of the prior study must not leak either.
  const knee = detectProcedure(
    'בדיקת MRI של הברך בוצעה בתאריך: 01/03/2026\nבהשוואה לבדיקת CT בטן קודמת.',
  );
  assert.equal(knee.modality, 'MRI');
  assert.equal(knee.bodyRegion, 'musculoskeletal');
});

test('performance is judged on the study, not on unrelated sentences', () => {
  // A signed referral is still a referral: treating the signature as proof of
  // performance coded a study that had not happened.
  assert.equal(
    detectProcedure('הפניה לבדיקת CT בטן\nד"ר לוי\nמסמך זה נחתם אלקטרונית').performed,
    false,
  );
  // The negative guard was document-global, so a sentence about the contrast
  // agent, or a recommendation for a *further* study, suppressed the code for a
  // study that was demonstrably done.
  assert.equal(
    detectProcedure('בדיקת CT בטן בוצעה בתאריך: 01/03/2026\nלא בוצעה הזרקת חומר ניגוד.').performed,
    true,
  );
  assert.equal(
    detectProcedure('בדיקת CT בטן בוצעה בתאריך: 01/03/2026\nמומלץ לבצע MRI להשלמה.').performed,
    true,
  );
});

test('a code is not offered unless it matches both the modality and the anatomy', () => {
  // A code matching only the modality reached the list on the floor score, so
  // its rank came from its code number: every CT with unmatched anatomy resolved
  // to 87.71, "CT of kidney". Such candidates stay visible for the coder but
  // must not be put forward.
  const analysis = buildLocalAnalysis(
    'בדיקת CT של האגן בוצעה בתאריך: 01/03/2026\nמסמך זה נחתם אלקטרונית',
    'ct.txt',
  );
  const { icd9 } = analysis.terminology.procedure;
  assert.equal(icd9.code, null);
  assert.equal(icd9.status, 'needs_review');
  assert.ok(icd9.candidates.length > 0, 'the coder still needs the list');
  assert.ok(icd9.candidates.every((candidate) => candidate.partial === true));
});

test('a code is never retrieved from the model\'s own free-text label', () => {
  // Falling back to the AI's label made the model the source of the code after
  // all. Every one of these returns a real catalog entry — so it passes the
  // never-invent-a-code check — while asserting something the report does not:
  // "Hepatic steatosis" retrieved 573.4 Hepatic infarction, and "mild
  // degenerative changes" retrieved an eye code.
  const labels = ['Hepatic steatosis', 'aortic atherosclerosis', 'mild degenerative changes', 'possible malignancy'];
  for (const label of labels) {
    const [mapping] = findingTerminology([{ key: 'ai_0', label, evidence: label }], 'abdomen');
    assert.equal(mapping.icd9.code, null, `${label} -> ${mapping.icd9.code} ${mapping.icd9.display}`);
    assert.equal(mapping.icd9.status, 'needs_review');
  }
  // A curated finding is unaffected.
  const [known] = findingTerminology([{ key: 'cholelithiasis', label: 'אבנים בכיס המרה', evidence: 'אבנים בכיס המרה' }], 'abdomen');
  assert.equal(known.icd9.code, '574.20');
});

test('an undocumented contrast study is not offered for a plain film', () => {
  // ICD-9 encodes the technique in the title rather than as a "with" clause, so
  // the qualifier penalty never sees it, and "contrast radiogram" repeats the
  // modality words — a plain abdominal film retrieved 88.11, "Pelvic opaque dye
  // contrast radiography", a separately billable procedure involving an
  // injection the report never documented.
  const analysis = buildLocalAnalysis(
    'צילום בטן בוצע בתאריך: 01/03/2026\nמסמך זה נחתם אלקטרונית',
    'xray.txt',
  );
  const { icd9 } = analysis.terminology.procedure;
  assert.equal(/contrast|opaque dye/i.test(icd9.display), false, icd9.display);
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

test('builds a Bedrock Runtime Converse request without exposing the source filename', () => {
  const request = buildBedrockRequest('Transcribe faithfully', 'cGRm');
  assert.deepEqual(request.messages[0].content[0], { text: 'Transcribe faithfully' });
  assert.deepEqual(request.messages[0].content[1], {
    document: {
      format: 'pdf',
      name: 'medical-document',
      source: { bytes: 'cGRm' },
    },
  });
  assert.deepEqual(request.inferenceConfig, { maxTokens: 12000 });
});

test('uses the regional Bedrock Runtime endpoint and bearer-token configuration', () => {
  const previous = {
    token: process.env.AWS_BEARER_TOKEN_BEDROCK,
    region: process.env.AWS_REGION,
    model: process.env.BEDROCK_MODEL_ID,
    baseUrl: process.env.BEDROCK_BASE_URL,
  };
  try {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-token';
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-5';
    delete process.env.BEDROCK_BASE_URL;
    const config = getAiConfig();
    assert.equal(config.provider, 'bedrock');
    assert.equal(config.token, 'test-token');
    assert.equal(
      bedrockConverseUrl(config),
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5/converse',
    );
  } finally {
    if (previous.token === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previous.token;
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.model === undefined) delete process.env.BEDROCK_MODEL_ID;
    else process.env.BEDROCK_MODEL_ID = previous.model;
    if (previous.baseUrl === undefined) delete process.env.BEDROCK_BASE_URL;
    else process.env.BEDROCK_BASE_URL = previous.baseUrl;
  }
});

test('debugging mode is explicit and defaults to disabled', () => {
  assert.equal(isDebuggingMode({}), false);
  assert.equal(isDebuggingMode({ DEBUGGING_MODE: 'false' }), false);
  assert.equal(isDebuggingMode({ DEBUGGING_MODE: 'true' }), true);
  assert.equal(isDebuggingMode({ DEBUGGING_MODE: '1' }), true);
});

test('telemetry emits timings only when debugging mode is enabled', async () => {
  const disabled = createTelemetry({ enabled: false, requestId: 'disabled-request' });
  await disabled.measure('local_analysis', () => Promise.resolve('ok'));
  assert.equal(disabled.snapshot(), null);
  assert.equal(disabled.serverTiming(), null);

  const enabled = createTelemetry({ enabled: true, requestId: 'debug-request' });
  await enabled.measure('local_analysis', () => Promise.resolve('ok'));
  enabled.recordAi({
    provider: 'bedrock',
    purpose: 'clinical_enhancement',
    wallMs: 15,
    providerLatencyMs: 12,
    inputTokens: 100,
    outputTokens: 25,
    status: 200,
  });
  enabled.setContext({ inputKind: 'pasted_text', inputBytes: 120 });
  const snapshot = enabled.snapshot();
  assert.equal(snapshot.requestId, 'debug-request');
  assert.equal(snapshot.aiCalls.length, 1);
  assert.equal(snapshot.aiCalls[0].provider, 'bedrock');
  assert.equal(snapshot.context.inputKind, 'pasted_text');
  assert.ok(snapshot.stages.local_analysis >= 0);
  assert.match(enabled.serverTiming(), /local_analysis;dur=/);
});
