# NXT ADS

NXT ADS is a Cloudflare Workers advertising intelligence platform for creating, managing, analyzing and optimizing paid advertising campaigns from one dashboard.

## Current architecture
- Cloudflare Workers API/runtime
- Cloudflare D1 for users, sessions, OAuth state, ad accounts, campaigns, creatives, payments and performance
- GitHub source of truth
- Responsive NXT ADS dashboard
- NXT AI creative generation
- Stripe Checkout + signed webhooks for NXT platform fees
- AES-GCM encrypted advertising OAuth tokens
- Google Ads OAuth, account discovery, token refresh, reporting and Search-campaign publishing
- OAuth/provider framework for Microsoft Advertising, Meta Ads, TikTok Ads and LinkedIn Ads

## Business / billing model

The campaign budget is the customer's planned advertising spend. NXT does not treat that budget as NXT revenue.

NXT charges a configurable platform fee (currently 12%) through Stripe. The connected advertising network remains responsible for the customer's actual ad billing. This keeps NXT revenue, customer ad spend and provider billing separate.

NXT_PLATFORM_FEE_BPS = 1200 means 12%.

Stripe webhook events are verified before payment records are marked paid. Production campaign publishing requires a confirmed NXT platform-fee payment.

## Security
- AUTH_SECRET signs application sessions.
- TOKEN_ENCRYPTION_KEY encrypts advertising OAuth access/refresh tokens before D1 storage.
- OAuth state values expire after 10 minutes.
- Production credentials are Worker Secrets, never GitHub files.
- Campaign and payment APIs enforce user ownership when authentication is enabled.
- Google Ads campaigns are created PAUSED so a user can review them before serving.

## Deployment
The repository contains a GitHub Actions deployment workflow that runs D1 migrations and deploys the Worker.

Required GitHub repository secrets for Actions:
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID

The internal Cloudflare secrets AUTH_SECRET and TOKEN_ENCRYPTION_KEY have already been generated and attached to the Worker.

## Provider credentials
Google Ads: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DEVELOPER_TOKEN, optional GOOGLE_LOGIN_CUSTOMER_ID.
Microsoft Advertising: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_DEVELOPER_TOKEN.
Meta Ads: META_APP_ID, META_APP_SECRET.
TikTok Ads: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.
LinkedIn Ads: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET.
Stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
NXT AI: AI_API_KEY, optional AI_API_URL and AI_MODEL.

## Final provider onboarding
Provider applications, developer tokens, API approval, OAuth redirect registration, ad-account permissions, Stripe activation and required business verification require access or approval outside the codebase. Those final steps must be completed by the platform owner.