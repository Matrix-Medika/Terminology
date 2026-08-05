# פריסת CODEX Clean Clinical Flow

## 1. דרישות שרת

- Linux x86_64
- Docker 24+ ו-Docker Compose
- Reverse proxy עם HTTPS, לדוגמה Nginx, Caddy או AWS ALB
- לפחות 2GB RAM

## 2. הגדרת סודות

```bash
cp .env.example .env
chmod 600 .env
```

עדכנו ב-`.env`:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6
```

המפתח נשאר בצד השרת בלבד.

## 3. הפעלה

```bash
docker compose up -d --build
curl http://127.0.0.1:4173/api/health
```

## 4. Reverse proxy

הפנו את `coding.matrix-medika.com` אל `127.0.0.1:4173` דרך HTTPS. מומלץ להגביל גודל בקשה ל-35MB ולהגדיר timeout של 120 שניות לעיבוד AI.

דוגמת Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name coding.matrix-medika.com;

    client_max_body_size 35m;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 5. פרטיות

היישום אינו שומר מסמכים או תוצאות. למרות זאת, לפני שימוש ב-PHI אמיתי יש להפעיל אותו רק בסביבה ארגונית מאושרת, עם בקרות גישה, הסכם עיבוד מתאים, ניטור ואישור אבטחת מידע. אתר דמו ציבורי צריך להשתמש במסמכים סינתטיים או אנונימיים בלבד.
