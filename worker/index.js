import { PROVIDERS, providerStatus } from "./providers.js";

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const id = (prefix="id") => prefix + "_" + crypto.randomUUID().replaceAll("-", "");

function feeFor(budgetCents, env) {
  const bps = Math.max(0, Number(env.NXT_PLATFORM_FEE_BPS || 1200));
  return Math.round(budgetCents * bps / 10000);
}

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ad_accounts (id TEXT PRIMARY KEY, user_id TEXT, provider TEXT NOT NULL, external_id TEXT, access_token TEXT, refresh_token TEXT, status TEXT DEFAULT 'connected', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, objective TEXT, status TEXT DEFAULT 'draft', budget_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, currency TEXT DEFAULT 'USD', start_date TEXT, end_date TEXT, providers TEXT, target_audience TEXT, website_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, campaign_id TEXT, provider TEXT, headline TEXT, description TEXT, cta TEXT, image_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT, campaign_id TEXT, provider TEXT, amount_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', external_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS performance_daily (id TEXT PRIMARY KEY, campaign_id TEXT, provider TEXT, day TEXT, spend_cents INTEGER DEFAULT 0, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, revenue_cents INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_generations (id TEXT PRIMARY KEY, user_id TEXT, campaign_id TEXT, prompt TEXT, output TEXT, provider TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_accounts_user ON ad_accounts(user_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_perf_campaign_day ON performance_daily(campaign_id, day)`)
  ]);
}\n\nasync function requireDb(env) {
  if (!env.DB) throw new Error("D1 is not configured. Add a database binding in wrangler.toml.");
}

async function aiGenerate(body, env) {
  if (!env.AI_API_KEY) {
    return {
      headline: "Your business, built for the next customer.",
      description: "Reach the right audience with a focused offer and a clear reason to act today.",
      cta: "Learn More",
      variants: [
        { headline: "Turn attention into customers.", description: "A clear message for people ready to discover your offer.", cta: "Get Started" },
        { headline: "Meet your next customer.", description: "Put your offer in front of the audience that matters.", cta: "Learn More" }
      ],
      note: "AI_API_KEY is not configured. Showing a safe preview."
    };
  }

  const endpoint = env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
  const model = env.AI_MODEL || "gpt-5.6-luna";
  const prompt = `Create high-converting advertising copy for this campaign. Return ONLY valid JSON with keys headline, description, cta, variants (array of 3 objects with headline, description, cta). Business: ${body.business || ""}. Offer: ${body.offer || ""}. Audience: ${body.audience || ""}. Goal: ${body.objective || "sales"}.`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0.7, messages: [
      { role: "system", content: "You are NXT AI, an advertising creative strategist. Follow ad platform policies and avoid unsupported claims." },
      { role: "user", content: prompt }
    ]})
  });
  if (!r.ok) throw new Error("AI provider returned " + r.status);
  const data = await r.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  const clean = raw.replace(/^\`\`\`json\s*/,"").replace(/\s*\`\`\`$/,"");
  return JSON.parse(clean);
}

async function stripeCheckout(body, env) {
  if (!env.STRIPE_SECRET_KEY) return { demo: true, message: "Stripe is not configured. Add STRIPE_SECRET_KEY to enable checkout.", amount_cents: body.amount_cents };
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", body.success_url || "https://example.com/billing/success");
  params.set("cancel_url", body.cancel_url || "https://example.com/billing/cancel");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][product_data][name]", "NXT ADS Campaign Budget");
  params.set("line_items[0][price_data][unit_amount]", String(body.amount_cents));
  params.set("line_items[0][quantity]", "1");
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method:"POST",
    headers: { authorization: "Basic " + btoa(env.STRIPE_SECRET_KEY + ":"), "content-type":"application/x-www-form-urlencoded" },
    body: params
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Stripe checkout failed");
  return { url: data.url, session_id: data.id };
}

async function dashboard(env) {
  await requireDb(env);
  const [campaigns, payments, perf] = await Promise.all([
    env.DB.prepare("SELECT * FROM campaigns ORDER BY updated_at DESC LIMIT 8").all(),
    env.DB.prepare("SELECT COALESCE(SUM(fee_cents),0) fee, COALESCE(SUM(amount_cents),0) gross FROM payments WHERE status='paid'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(spend_cents),0) spend, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(conversions),0) conversions, COALESCE(SUM(revenue_cents),0) revenue FROM performance_daily").first()
  ]);
  return { campaigns: campaigns.results || [], payments: payments || {}, performance: perf || {} };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok:true, app:"NXT ADS", time:new Date().toISOString() });
      if (path === "/api/providers") return json({ providers: providerStatus(env) });

      if (path === "/api/ai/generate" && request.method === "POST") {
        return json(await aiGenerate(await request.json(), env));
      }

      if (path === "/api/billing/checkout" && request.method === "POST") {
        const body = await request.json();
        const amount = Math.max(100, Number(body.amount_cents || 0));
        return json(await stripeCheckout({ ...body, amount_cents: amount }, env));
      }

      if (path === "/api/dashboard") return json(await dashboard(env));

      if (path === "/api/campaigns" && request.method === "GET") {
        await requireDb(env);
        const r = await env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100").all();
        return json(r.results || []);
      }

      if (path === "/api/campaigns" && request.method === "POST") {
        await requireDb(env);
        const b = await request.json();
        const budget = Math.max(0, Number(b.budget_cents || 0));
        const campaignId = id("cmp");
        const fee = feeFor(budget, env);
        await env.DB.prepare(`INSERT INTO campaigns (id,user_id,name,objective,status,budget_cents,fee_cents,currency,start_date,end_date,providers,target_audience,website_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(campaignId,b.user_id||"demo-user",b.name||"Untitled Campaign",b.objective||"sales","draft",budget,fee,"USD",b.start_date||null,b.end_date||null,JSON.stringify(b.providers||[]),b.audience||"",b.website_url||null).run();
        return json({ id:campaignId, fee_cents:fee, total_cents:budget+fee });
      }

      if (path === "/api/ads" && request.method === "POST") {
        await requireDb(env);
        const b=await request.json();
        const adId=id("ad");
        await env.DB.prepare("INSERT INTO ads (id,campaign_id,provider,headline,description,cta,image_url) VALUES (?,?,?,?,?,?,?)")
          .bind(adId,b.campaign_id,b.provider||null,b.headline||"",b.description||"",b.cta||"Learn More",b.image_url||null).run();
        return json({id:adId});
      }

      if (path === "/api/providers/connect") {
        const provider = url.searchParams.get("provider");
        if (!PROVIDERS[provider]) return json({error:"Unsupported provider"},400);
        return json({ provider, configured: providerStatus(env).find(x=>x.id===provider)?.configured || false, message:"OAuth callback integration is ready for provider credentials." });
      }

      if (path.startsWith("/api/")) return json({error:"Not found"},404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error:e.message || "Internal error" }, 500);
    }
  }
};