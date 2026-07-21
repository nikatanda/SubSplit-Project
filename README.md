# SubSplit

SubSplit is a subscription-sharing and recurring-cost tracker for friends, families, roommates, and small teams.

## Included in this MVP

- Secure registration and login with hashed passwords and JWT sessions
- Groups with owner/member roles and email-based in-app invitations
- Active and cancelled subscriptions, category, currency, billing day, and payer
- Equal, percentage, and custom-amount splits
- Automatic monthly balances and simplified settlement suggestions
- Payment confirmation and responsive dashboard

Future ideas from the product plan—OAuth, email delivery, notifications, analytics, PDF export, multi-currency conversions, and AI insights—are intentionally not part of the current MVP.

## Run locally

1. Create `backend/.env` and set a real PostgreSQL `DATABASE_URL` plus a secure `JWT_SECRET`. This machine's PostgreSQL server uses port `5000`; the API uses `5001` to avoid a port conflict.
2. In `backend`, run `npm run db:push`, then `npm run dev`.
3. In `frontend`, run `npm run dev` and open `http://localhost:5173`.

## Main API routes

`/api/auth`, `/api/groups`, `/api/invitations`, `/api/subscriptions`, `/api/payments`, and `/api/reports`.

## Email notifications

SubSplit sends email notifications for group invitations, new subscriptions, and confirmed payments when SMTP is configured. Add the following values to `backend/.env` (do not commit this file):

```env
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER="your-address@gmail.com"
SMTP_PASS="your-16-character-Google-App-Password"
SMTP_FROM="SubSplit <your-address@gmail.com>"
APP_URL="http://localhost:5173"
```

For Gmail, enable two-step verification and create an App Password; your ordinary Gmail password will not work for SMTP.
