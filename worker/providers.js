export const PROVIDERS = {
  google: {
    name: "Google Ads",
    oauth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token", clientIdSecret:"GOOGLE_CLIENT_ID", clientSecretSecret:"GOOGLE_CLIENT_SECRET",
    api: "https://googleads.googleapis.com",
    scopes: ["https://www.googleapis.com/auth/adwords"]
  },
  microsoft: {
    name: "Microsoft Advertising",
    oauth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", clientIdSecret:"MICROSOFT_CLIENT_ID", clientSecretSecret:"MICROSOFT_CLIENT_SECRET",
    api: "https://campaign.api.bingads.microsoft.com",
    scopes: ["https://ads.microsoft.com/msads.manage"]
  },
  meta: {
    name: "Meta Ads",
    oauth: "https://www.facebook.com/v23.0/dialog/oauth",
    token: "https://graph.facebook.com/v23.0/oauth/access_token", clientIdSecret:"META_APP_ID", clientSecretSecret:"META_APP_SECRET",
    api: "https://graph.facebook.com/v23.0",
    scopes: ["ads_management", "ads_read"]
  },
  tiktok: {
    name: "TikTok Ads",
    oauth: "https://business-api.tiktok.com/portal/auth",
    token: "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", clientIdSecret:"TIKTOK_CLIENT_KEY", clientSecretSecret:"TIKTOK_CLIENT_SECRET",
    api: "https://business-api.tiktok.com/open_api",
    scopes: ["ad_management"]
  },
  linkedin: {
    name: "LinkedIn Ads",
    oauth: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken", clientIdSecret:"LINKEDIN_CLIENT_ID", clientSecretSecret:"LINKEDIN_CLIENT_SECRET",
    api: "https://api.linkedin.com",
    scopes: ["r_liteprofile", "r_ads", "rw_ads"]
  }
};

export function providerStatus(env) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name,
    configured:
      id === "google" ? !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_DEVELOPER_TOKEN) :
      id === "microsoft" ? !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_DEVELOPER_TOKEN) :
      id === "meta" ? !!(env.META_APP_ID && env.META_APP_SECRET) :
      id === "tiktok" ? !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET) :
      id === "linkedin" ? !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET) : false
  }));
}

export async function networkRequest(provider, url, init = {}, env) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${provider} API ${response.status}: ${JSON.stringify(data).slice(0, 600)}`);
  return data;
}