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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, avatar_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, user_id TEXT, provider TEXT NOT NULL, kind TEXT NOT NULL, code_verifier TEXT, expires_at INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ad_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT, account_name TEXT, access_token TEXT, refresh_token TEXT, token_expires_at TEXT, status TEXT DEFAULT 'connected', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, objective TEXT, status TEXT DEFAULT 'draft', budget_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, currency TEXT DEFAULT 'USD', start_date TEXT, end_date TEXT, providers TEXT, target_audience TEXT, website_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, campaign_id TEXT, provider TEXT, headline TEXT, description TEXT, cta TEXT, image_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, campaign_id TEXT, provider_payment_id TEXT, amount_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, ad_budget_cents INTEGER DEFAULT 0, currency TEXT DEFAULT 'USD', status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS performance_daily (id TEXT PRIMARY KEY, campaign_id TEXT, provider TEXT, day TEXT, spend_cents INTEGER DEFAULT 0, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, revenue_cents INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_generations (id TEXT PRIMARY KEY, user_id TEXT, campaign_id TEXT, prompt TEXT, output TEXT, provider TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_accounts_user ON ad_accounts(user_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_perf_campaign_day ON performance_daily(campaign_id, day)`)
  ]);
}

async function requireDb(env) {
  if (!env.DB) throw new Error("D1 is not configured. Add a database binding in wrangler.toml.");
  await ensureSchema(env);
}

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)), c=>c.charCodeAt(0));

async function hmac(secret, data) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(data)));
}
async function makeSession(userId, env) {
  const payload=b64(new TextEncoder().encode(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+60*60*24*30})));
  const sig=b64(await hmac(env.AUTH_SECRET,payload));
  const sid=id("sess");
  await env.DB.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").bind(sid,userId,Math.floor(Date.now()/1000)+60*60*24*30).run();
  return sid+"."+payload+"."+sig;
}
async function currentUser(request, env) {
  if(!env.AUTH_SECRET || !env.DB) return null;
  const raw=request.headers.get("Cookie")?.match(/nxt_session=([^;]+)/)?.[1];
  if(!raw) return null;
  const [sid,payload,sig]=raw.split(".");
  if(!sid||!payload||!sig) return null;
  const good=await crypto.subtle.verify("HMAC",await crypto.subtle.importKey("raw",new TextEncoder().encode(env.AUTH_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]),unb64(sig),new TextEncoder().encode(payload)).catch(()=>false);
  if(!good) return null;
  let p; try{p=JSON.parse(new TextDecoder().decode(unb64(payload)))}catch{return null}
  if(p.exp<Date.now()/1000) return null;
  const row=await env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?").bind(sid,Math.floor(Date.now()/1000)).first();
  return row||null;
}
function sessionResponse(data, token, request) {
  const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
  if(token) headers["set-cookie"]=`nxt_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
  return new Response(JSON.stringify(data),{status:200,headers});
}
async function oauthStart(provider, kind, request, env) {
  await requireDb(env);
  const cfg=PROVIDERS[provider];
  const clientId=env[cfg.clientIdSecret];
  if(!clientId) return json({error:`Missing ${cfg.clientIdSecret}`},503);
  const state=id("oauth");
  await env.DB.prepare("INSERT INTO oauth_states (state,provider,kind,expires_at) VALUES (?,?,?,?)").bind(state,provider,kind,Math.floor(Date.now()/1000)+600).run();
  const redirect=new URL(request.url); redirect.pathname=`/api/oauth/${provider}/callback`; redirect.search="";
  const u=new URL(cfg.oauth); u.searchParams.set("client_id",clientId); u.searchParams.set("redirect_uri",redirect.toString()); u.searchParams.set("response_type","code"); u.searchParams.set("state",state); u.searchParams.set("scope",cfg.scopes.join(" "));
  return Response.redirect(u.toString(),302);
}
async function oauthCallback(provider, request, env) {
  await requireDb(env);
  const cfg=PROVIDERS[provider], u=new URL(request.url), state=u.searchParams.get("state"), code=u.searchParams.get("code");
  if(!state||!code) return json({error:"OAuth callback missing code or state"},400);
  const st=await env.DB.prepare("SELECT * FROM oauth_states WHERE state=? AND expires_at>?").bind(state,Math.floor(Date.now()/1000)).first();
  if(!st||st.provider!==provider) return json({error:"Invalid or expired OAuth state"},400);
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  const clientId=env[cfg.clientIdSecret], clientSecret=env[cfg.clientSecretSecret];
  const redirect=new URL(request.url); redirect.search="";
  const tokenBody=new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,grant_type:"authorization_code",redirect_uri:redirect.toString()});
  const tr=await fetch(cfg.token,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:tokenBody});
  const td=await tr.json(); if(!tr.ok) return json({error:"OAuth token exchange failed",detail:td},400);
  const access=td.access_token; if(!access) return json({error:"Provider did not return an access token"},400);
  let identity={email:null,name:null};
  if(provider==="google"){const r=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{authorization:"Bearer "+access}});if(r.ok){const x=await r.json();identity={email:x.email,name:x.name}}}
  else if(provider==="microsoft"){const r=await fetch("https://graph.microsoft.com/v1.0/me",{headers:{authorization:"Bearer "+access}});if(r.ok){const x=await r.json();identity={email:x.mail||x.userPrincipalName,name:x.displayName}}}
  const email=identity.email||`${provider}_${id()}@oauth.nxtads.local`;
  const uid=id("usr");
  await env.DB.prepare("INSERT INTO users (id,email,name) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name").bind(uid,email,identity.name||provider).run();
  const user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  await env.DB.prepare("INSERT INTO ad_accounts (id,user_id,provider,access_token,refresh_token,token_expires_at,status) VALUES (?,?,?,?,?,?,?)").bind(id("acct"),user.id,provider,access,td.refresh_token||null,td.expires_in?new Date(Date.now()+td.expires_in*1000).toISOString():null,"connected").run();
  const token=await makeSession(user.id,env);
  return sessionResponse({ok:true,user:{id:user.id,email:user.email,name:user.name},provider},token,request);
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