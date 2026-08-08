# CODEX / קוד מדויק — Clinical Coding & Billing

גרסת שרת וממשק נקייה למסלול:

`מסמך → טקסט → עובדות קליניות → ממצאים → טרמינולוגיה → חיוב → בדיקה אנושית`

## מה שונה

- אין Sidebar, Dashboard או כרטיסי Revenue במסלול העלאת מסמך.
- התוצאה מתחילה ב־Clinical Facts ולא בקוד.
- כל ממצא מוצג עם ראיה מתוך המקור.
- ICD‑9, SNOMED וקוד השירות מחושבים רק אחרי זיהוי הפרוצדורה.
- דו״ח RIS חתום נחשב ראיית ביצוע; התחייבות ומבטח נדרשים לסכום התביעה, לא לעצם זיהוי קוד השירות.
- חומר ניגוד שלא תועד נשאר `לא תועד` — המערכת אינה מנחשת.
- אין מקרה דמו שמחליף קובץ שנכשל.
- תמיכה מקומית ב־PDF עם `pdftotext`, וב־AI OCR כגיבוי דרך Amazon Bedrock Runtime או OpenAI.

## הרצה

דרישות:

- Node.js 20+
- Poppler (`pdftotext`) מומלץ לעיבוד מקומי
- לחלופין: Amazon Bedrock Runtime או OpenAI לעיבוד PDF בענן ולחילוץ AI משלים

```bash
cd codex-clean-flow
npm test
AWS_BEARER_TOKEN_BEDROCK=... BEDROCK_MODEL_ID=... npm start
```

פתחי:

```text
http://127.0.0.1:4173
```


## פריסה לשרת

החבילה כוללת `Dockerfile`, ‏`docker-compose.yml`, בדיקת בריאות וראשי אבטחה בסיסיים. ראו `DEPLOYMENT.md` לפריסה מאחורי HTTPS.

## משתני סביבה

```text
PORT=4173
DEBUGGING_MODE=false
AWS_REGION=us-east-1
BEDROCK_BASE_URL=
AWS_BEARER_TOKEN_BEDROCK=
BEDROCK_MODEL_ID=us.anthropic.claude-opus-5
BEDROCK_SERVICE_TIER=

# ספק חלופי אופציונלי
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6
```

`BEDROCK_BASE_URL` נדרש רק עבור VPC endpoint או proxy; כאשר הוא ריק, השרת משתמש ב־`bedrock-runtime.<region>.amazonaws.com`. אין להוסיף `/model` לכתובת.

### טלמטריית ביצועים מקומית

הגדירי `DEBUGGING_MODE=true` כדי להפעיל טלמטריה ללא תוכן רפואי. במצב זה השרת:

- כותב ללוג אירוע JSON בשם `analysis_telemetry` עם זמני השלבים, מספר קריאות AI, latency ו־token usage שהספק החזיר.
- מחזיר `Server-Timing` ו־`X-Debug-Request-Id` בבקשת `/api/analyze`.
- מוסיף `debugTelemetry` לתגובת הפיתוח ומציג אותה ב־Console של הדפדפן.

הטלמטריה אינה כוללת prompt, תוכן מסמך, שם קובץ, מפתח API או מזהי מטופל. בפרודקשן יש להשאיר `DEBUGGING_MODE=false` או להסיר את המשתנה לחלוטין; במצב זה לא נכתב לוג טלמטריה ולא מוחזרים שדות או headers של debug.

המפתחות נשמרים בשרת בלבד ואינם נשלחים לדפדפן. כאשר שני הספקים מוגדרים, Bedrock מקבל עדיפות. קריאות Bedrock Converse אינן שומרות את המסמך, וקריאות OpenAI מוגדרות עם `store: false`.

## הערת קידוד

הקודים בדוגמת MRI צווארי מגיעים מקטלוג ההדגמה הטעון בפרויקט. בפריסת בית חולים יש להחליף אותו בקטלוגים מאושרים, גרסאיים ובעלי תאריך תחולה.

## תצוגת UX

מסך התוצאה תוכנן מחדש כך שמידע הכרחי בלבד פתוח כברירת מחדל. סדר הצפייה הוא עובדות, ממצאים, קודים וחיוב. מיפויי ממצאים, אי־ודאויות ופרטים טכניים נמצאים תחת הרחבה יזומה.

ראו `FLOW_CHANGELOG.md` לפירוט השינויים.
