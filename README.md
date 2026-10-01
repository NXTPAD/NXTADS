# NXT ADS

NXT ADS is a Cloudflare Workers advertising intelligence platform.

## Stack
- Cloudflare Workers + Static Assets
- Cloudflare D1
- GitHub Actions
- AI provider API
- Stripe Checkout
- Google Ads / Microsoft Advertising / Meta / TikTok / LinkedIn adapters

## Deploy
1. Create a D1 database: `npx wrangler d1 create nxt-ads`
2. Put its ID in `wrangler.toml`.
3. Run `npx wrangler d1 migrations apply nxt-ads --remote`.
4. Add secrets with `npx wrangler secret put NAME`.
5. Run `npm install && npm run deploy`.

For GitHub Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Production API credentials
Add the credentials supplied by each advertising provider as Worker Secrets. Never commit production keys to GitHub.

## Business model
NXT_PLATFORM_FEE_BPS controls the NXT platform fee. 1200 = 12%. This value is configurable and should be reviewed against payment costs, network terms, taxes and applicable laws before production use.

## Important
Advertising network APIs require provider-specific app registration, OAuth approval, developer/API access and account permissions. The UI and server adapter architecture are prepared for those credentials; provider onboarding and approval cannot be completed by code alone.