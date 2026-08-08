import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBidi,
  detectPatient,
  detectProcedure,
  detectFindings,
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
