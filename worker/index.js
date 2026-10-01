import { PROVIDERS, providerStatus } from "./providers.js";

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const id = (prefix="id") => prefix + "_" + crypto.randomUUID().replaceAll("-", "");

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (user) return user;
  if (!env.AUTH_SECRET) return {id:"demo-user",email:"demo@nxtads.local",name:"Demo"};
  throw new Error("Authentication required");
}

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
  let connectUser=null;
  if(kind==="connect") connectUser=await requireUser(request,env);
  const cfg=PROVIDERS[provider];
  const clientId=env[cfg.clientIdSecret];
  if(!clientId) return json({error:`Missing ${cfg.clientIdSecret}`},503);
  const state=id("oauth");
  await env.DB.prepare("INSERT INTO oauth_states (state,provider,kind,expires_at) VALUES (?,?,?,?)").bind(state,connectUser?.id||null,provider,kind,Math.floor(Date.now()/1000)+600).run();
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
  let user=null;
  if(st.kind==="connect"){
    user=await currentUser(request,env);
    if(!user || user.id!==st.user_id) return json({error:"Connection session expired. Please start again."},401);
  } else {
    const email=provider+"_"+id()+"@oauth.nxtads.local";
    if(identity.email) { user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(identity.email).first(); }
    if(!user){
      await env.DB.prepare("INSERT INTO users (id,email,name) VALUES (?,?,?)").bind(id("usr"),identity.email||email,identity.name||provider).run();
      user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(identity.email||email).first();
    }
  }
  const accessStored=await encryptToken(access,env), refreshStored=await encryptToken(td.refresh_token||null,env);
  await env.DB.prepare("INSERT INTO ad_accounts (id,user_id,provider,access_token,refresh_token,token_expires_at,status) VALUES (?,?,?,?,?,?,?)").bind(id("acct"),user.id,provider,accessStored,refreshStored,td.expires_in?new Date(Date.now()+td.expires_in*1000).toISOString():null,"connected").run();
  const token=st.kind==="login"?await makeSession(user.id,env):null;
  return sessionResponse({ok:true,user:{id:user.id,email:user.email,name:user.name},provider,connected:true},token,request);
}

async function encryptToken(value,env){
  if(!value) return null;
  if(!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is required before connecting an ad account");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY));
  const key=await crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt"]);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value));
  return "enc:v1:"+b64(iv)+":"+b64(data);
}
async function decryptToken(value,env){
  if(!value) return null;
  if(!value.startsWith("enc:v1:")) return null;
  if(!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const [,v,iv64,data64]=value.split(":");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY));
  const key=await crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["decrypt"]);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv64)},key,unb64(data64));
  return new TextDecoder().decode(plain);
}
async function discoverGoogleAccounts(user,env){
  if(!env.GOOGLE_DEVELOPER_TOKEN) return [];
  const account=await env.DB.prepare("SELECT * FROM ad_accounts WHERE user_id=? AND provider='google' ORDER BY created_at DESC LIMIT 1").bind(user.id).first();
  if(!account) return [];
  const access=await decryptToken(account.access_token,env);
  if(!access) return [];
  const r=await fetch("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",{headers:{authorization:"Bearer "+access,"developer-token":env.GOOGLE_DEVELOPER_TOKEN}});
  const data=await r.json();
  if(!r.ok) throw new Error("Google Ads account discovery failed: "+JSON.stringify(data).slice(0,500));
  const ids=(data.resourceNames||[]).map(x=>x.split("/").pop()).filter(Boolean);
  for(const externalId of ids){
    const exists=await env.DB.prepare("SELECT id FROM ad_accounts WHERE user_id=? AND provider='google' AND external_id=?").bind(user.id,externalId).first();
    if(exists) await env.DB.prepare("UPDATE ad_accounts SET status='connected' WHERE id=?").bind(exists.id).run();
    else await env.DB.prepare("INSERT INTO ad_accounts (id,user_id,provider,external_id,account_name,status) VALUES (?,?,?,?,?,?)").bind(id("acct"),user.id,"google",externalId,"Google Ads "+externalId,"connected").run();
  }
  return ids;
}
async function googleApi(path,access,env,body){
  const headers={"content-type":"application/json","authorization:"+" Bearer "+access,"developer-token":env.GOOGLE_DEVELOPER_TOKEN};
  if(env.GOOGLE_LOGIN_CUSTOMER_ID) headers["login-customer-id"]=String(env.GOOGLE_LOGIN_CUSTOMER_ID).replaceAll("-","");
  const r=await fetch("https://googleads.googleapis.com/v25"+path,{method:"POST",headers,body:JSON.stringify(body)});
  const data=await r.json(); if(!r.ok) throw new Error("Google Ads API "+r.status+": "+JSON.stringify(data).slice(0,900)); return data;
}
async function publishGoogleCampaign(user,campaign,ad,account,env){
  if(!env.GOOGLE_DEVELOPER_TOKEN) throw new Error("GOOGLE_DEVELOPER_TOKEN is not configured");
  const access=await decryptToken(account.access_token,env); if(!access) throw new Error("Google Ads account token is unavailable");
  const cid=account.external_id;
  if(!/^\d{6,20}$/.test(String(cid))) throw new Error("Invalid Google Ads customer ID");
  const daily=Math.max(500000,Math.round((Number(campaign.budget_cents||0)/30)*10000));
  const budget=await googleApi(`/customers/${cid}/campaignBudgets:mutate`,access,env,{operations:[{create:{name:"NXT ADS Budget "+campaign.id,deliveryMethod:"STANDARD",amountMicros:String(daily),explicitlyShared:false}}]});
  const budgetResource=budget.results?.[0]?.resourceName; if(!budgetResource) throw new Error("Google Ads did not return a budget resource");
  const camp=await googleApi(`/customers/${cid}/campaigns:mutate`,access,env,{operations:[{create:{name:campaign.name,advertisingChannelType:"SEARCH",status:"PAUSED",manualCpc:{},campaignBudget:budgetResource,networkSettings:{targetGoogleSearch:true,targetSearchNetwork:true,targetContentNetwork:false,targetPartnerSearchNetwork:false}}}]});
  const campaignResource=camp.results?.[0]?.resourceName; if(!campaignResource) throw new Error("Google Ads did not return a campaign resource");
  const group=await googleApi(`/customers/${cid}/adGroups:mutate`,access,env,{operations:[{create:{name:campaign.name+" Ad Group",status:"PAUSED",campaign:campaignResource,type:"SEARCH_STANDARD"}}]});
  const groupResource=group.results?.[0]?.resourceName; if(!groupResource) throw new Error("Google Ads did not return an ad group resource");
  const headline=(ad?.headline||campaign.name||"Discover our offer").slice(0,30);
  const description=(ad?.description||"Learn more about our offer and get started today.").slice(0,90);
  const second=(ad?.cta||"Get Started").slice(0,30);
  const third=(campaign.objective||"Grow your business").slice(0,30);
  const finalUrl=campaign.website_url; if(!/^https?:\/\//i.test(finalUrl||"")) throw new Error("A valid campaign website URL is required");
  const adResp=await googleApi(`/customers/${cid}/adGroupAds:mutate`,access,env,{operations:[{create:{status:"PAUSED",adGroup:groupResource,ad:{finalUrls:[finalUrl],responsiveSearchAd:{headlines:[{text:headline},{text:second},{text:third}],descriptions:[{text:description},{text:(description+" "+second).slice(0,90)}]}}}}]});
  const keyword=((campaign.target_audience||campaign.name||"business").toLowerCase().replace(/[^a-z0-9 ]/g," ").trim().split(/\s+/).filter(Boolean).slice(0,4).join(" ")||"business");
  await googleApi(`/customers/${cid}/adGroupCriteria:mutate`,access,env,{operations:[{create:{adGroup:groupResource,status:"PAUSED,keyword:{text:keyword,matchType:"BROAD"}}}]});
  const externalId=campaignResource.split("/").pop();
  await env.DB.prepare("UPDATE campaigns SET status='connected',providers=? WHERE id=?").bind(JSON.stringify([{provider:"google",customer_id:cid,external_id:externalId}]),campaign.id).run();
  return {provider:"google",customer_id:cid,campaign_resource:campaignResource,ad_group_resource:groupResource};
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
  const budget=Math.max(100,Number(body.amount_cents||0));
  const fee=feeFor(budget,env), total=budget+fee;
  if (!env.STRIPE_SECRET_KEY) return {demo:true,budget_cents:budget,fee_cents:fee,total_cents:total,message:"Stripe is not configured yet."};
  await requireDb(env);
  const paymentId=id("pay");
  await env.DB.prepare("INSERT INTO payments (id,user_id,campaign_id,amount_cents,fee_cents,ad_budget_cents,currency,status) VALUES (?,?,?,?,?,?,?,'pending')")
    .bind(paymentId,body.user_id,body.campaign_id||null,total,fee,budget,"USD").run();
  const params=new URLSearchParams();
  params.set("mode","payment");
  params.set("success_url",body.success_url||new URL("/?payment=success",body.origin||"https://nxt-ads.ezdevsupport.workers.dev").toString());
  params.set("cancel_url",body.cancel_url||new URL("/?payment=cancel",body.origin||"https://nxt-ads.ezdevsupport.workers.dev").toString());
  params.set("line_items[0][price_data][currency]","usd");
  params.set("line_items[0][price_data][product_data][name]","NXT ADS Advertising Budget");
  params.set("line_items[0][price_data][unit_amount]",String(budget));
  params.set("line_items[0][price_data][product_data][description]","Advertising spend allocated to your connected ad account");
  params.set("line_items[0][quantity]","1");
  params.set("line_items[1][price_data][currency]","usd");
  params.set("line_items[1][price_data][product_data][name]","NXT ADS Platform Fee");
  params.set("line_items[1][price_data][unit_amount]",String(fee));
  params.set("line_items[1][quantity]","1");
  params.set("metadata[payment_id]",paymentId);
  params.set("metadata[user_id]",body.user_id);
  if(body.campaign_id) params.set("metadata[campaign_id]",body.campaign_id);
  const r=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{authorization:"Basic "+btoa(env.STRIPE_SECRET_KEY+":"),"content-type":"application/x-www-form-urlencoded"},body:params});
  const data=await r.json();
  if(!r.ok){await env.DB.prepare("UPDATE payments SET status='failed' WHERE id=?").bind(paymentId).run();throw new Error(data.error?.message||"Stripe checkout failed")}
  await env.DB.prepare("UPDATE payments SET provider_payment_id=? WHERE id=?").bind(data.id,paymentId).run();
  return {url:data.url,session_id:data.id,payment_id:paymentId,budget_cents:budget,fee_cents:fee,total_cents:total};
}
async function stripeWebhook(request,env){
  if(!env.STRIPE_WEBHOOK_SECRET) return json({error:"Stripe webhook secret is not configured"},503);
  const sig=request.headers.get("Stripe-Signature")||"", raw=await request.text();
  const parts=Object.fromEntries(sig.split(",").map(x=>x.split("=").map(v=>v.trim())));
  const ts=Number(parts.t), v1=parts.v1;
  if(!ts||!v1||Math.abs(Date.now()/1000-ts)>300) return json({error:"Invalid webhook timestamp"},400);
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const expected=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(ts+"."+raw)));
  const hex=Array.from(expected).map(x=>x.toString(16).padStart(2,"0")).join("");
  if(hex!==v1) return json({error:"Invalid webhook signature"},400);
  const event=JSON.parse(raw), obj=event.data?.object||{};
  const paymentId=obj.metadata?.payment_id;
  if(paymentId){
    const status=event.type==="checkout.session.completed"||event.type==="checkout.session.async_payment_succeeded"?"paid":event.type==="checkout.session.async_payment_failed"?"failed":null;
    if(status) await env.DB.prepare("UPDATE payments SET status=? WHERE id=?").bind(status,paymentId).run();
  }
  return json({received:true});
}

async function dashboard(request, env) {
  await requireDb(env);
  const user=await requireUser(request,env);
  const [campaigns, payments, perf] = await Promise.all([
    env.DB.prepare("SELECT * FROM campaigns WHERE user_id=? ORDER BY updated_at DESC LIMIT 8").bind(user.id).all(),
    env.DB.prepare("SELECT COALESCE(SUM(fee_cents),0) fee, COALESCE(SUM(amount_cents),0) gross FROM payments WHERE status='paid' AND user_id=?").bind(user.id).first(),
    env.DB.prepare("SELECT COALESCE(SUM(p.spend_cents),0) spend, COALESCE(SUM(p.clicks),0) clicks, COALESCE(SUM(p.conversions),0) conversions, COALESCE(SUM(p.revenue_cents),0) revenue FROM performance_daily p JOIN campaigns c ON c.id=p.campaign_id WHERE c.user_id=?").bind(user.id).first()
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
      if (path === "/api/auth/:provider") { /* reserved */ }
      const authMatch=path.match(/^\/api\/auth\/([a-z]+)$/);
      if(authMatch && request.method==="GET" && PROVIDERS[authMatch[1]]) return await oauthStart(authMatch[1],"login",request,env);
      const cbMatch=path.match(/^\/api\/oauth\/([a-z]+)\/callback$/);
      if(cbMatch && request.method==="GET" && PROVIDERS[cbMatch[1]]) return await oauthCallback(cbMatch[1],request,env);
      if(path==="/api/accounts" && request.method==="GET"){
        await requireDb(env); const user=await requireUser(request,env);
        try{await discoverGoogleAccounts(user,env)}catch(e){return json({accounts:[],error:e.message},502)}
        const r=await env.DB.prepare("SELECT id,provider,external_id,account_name,status,token_expires_at,created_at FROM ad_accounts WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
        return json({accounts:r.results||[]});
      }
      if(path==="/api/auth/me"){ await requireDb(env); const user=await currentUser(request,env); return json({authenticated:!!user,user:user?{id:user.id,email:user.email,name:user.name}:null}); }
      if(path==="/api/auth/logout" && request.method==="POST"){ const h={"content-type":"application/json; charset=utf-8","set-cookie":"nxt_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"}; return new Response(JSON.stringify({ok:true}),{headers:h}); }

      if (path === "/api/ai/generate" && request.method === "POST") {
        return json(await aiGenerate(await request.json(), env));
      }

      if (path === "/api/billing/webhook" && request.method === "POST") return await stripeWebhook(request,env);

      if (path === "/api/billing/checkout" && request.method === "POST") {
        const body = await request.json();
        const user=await requireUser(request,env);
        const amount = Math.max(100, Number(body.amount_cents || 0));
        return json(await stripeCheckout({ ...body, amount_cents: amount, user_id:user.id }, env));
      }

      if (path === "/api/dashboard") return json(await dashboard(request,env));
      if(path==="/api/finance"){await requireDb(env);const user=await requireUser(request,env);const x=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN fee_cents ELSE 0 END),0) fees,COALESCE(SUM(CASE WHEN status='paid' THEN ad_budget_cents ELSE 0 END),0) ad_budget,COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) gross,COUNT(CASE WHEN status='paid' THEN 1 END) paid_orders FROM payments WHERE user_id=?").bind(user.id).first();return json(x||{});}

      if (path === "/api/campaigns" && request.method === "GET") {
        await requireDb(env);
        const user=await requireUser(request,env); const r = await env.DB.prepare("SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
        return json(r.results || []);
      }

      if (path === "/api/campaigns" && request.method === "POST") {
        await requireDb(env);
        const b = await request.json();
        const user=await requireUser(request,env);
        const budget = Math.max(0, Number(b.budget_cents || 0));
        const campaignId = id("cmp");
        const fee = feeFor(budget, env);
        await env.DB.prepare(`INSERT INTO campaigns (id,user_id,name,objective,status,budget_cents,fee_cents,currency,start_date,end_date,providers,target_audience,website_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(campaignId,user.id,b.name||"Untitled Campaign",b.objective||"sales","draft",budget,fee,"USD",b.start_date||null,b.end_date||null,JSON.stringify(b.providers||[]),b.audience||"",b.website_url||null).run();
        return json({ id:campaignId, fee_cents:fee, total_cents:budget+fee });
      }

      const publishMatch=path.match(/^\/api\/campaigns\/([^/]+)\/publish$/);
      if(publishMatch && request.method==="POST"){
        await requireDb(env); const user=await requireUser(request,env), cid=publishMatch[1], body=await request.json();
        const campaign=await env.DB.prepare("SELECT * FROM campaigns WHERE id=? AND user_id=?").bind(cid,user.id).first();
        if(!campaign) return json({error:"Campaign not found"},404);
        const provider=body.provider||"google";
        if(provider!=="google") return json({error:"This provider adapter is being enabled next; campaign remains safely in draft."},501);
        const account=await env.DB.prepare("SELECT * FROM ad_accounts WHERE id=? AND user_id=? AND provider='google'").bind(body.ad_account_id,user.id).first();
        if(!account) return json({error:"Select a connected Google Ads account"},400);
        const ad=await env.DB.prepare("SELECT * FROM ads WHERE campaign_id=? ORDER BY created_at DESC LIMIT 1").bind(cid).first();
        if(!ad) return json({error:"Create an ad creative before publishing"},400);
        try{return json(await publishGoogleCampaign(user,campaign,ad,account,env))}catch(e){await env.DB.prepare("UPDATE campaigns SET status='error' WHERE id=?").bind(cid).run();throw e}
      }

      if (path === "/api/ads" && request.method === "POST") {
        await requireDb(env);
        const b=await request.json();
        const adId=id("ad");
        await env.DB.prepare("INSERT INTO ads (id,campaign_id,provider,headline,description,cta,image_url) VALUES (?,?,?,?,?,?,?)")
          .bind(adId,b.campaign_id,b.provider||null,b.headline||"",b.description||"",b.cta||"Learn More",b.image_url||null).run();
        return json({id:adId});
      }

      const connectMatch=path.match(/^\/api\/providers\/([^/]+)\/connect$/);
      if(connectMatch && request.method==="GET" && PROVIDERS[connectMatch[1]]) return await oauthStart(connectMatch[1],"connect",request,env);

      if (path.startsWith("/api/")) return json({error:"Not found"},404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error:e.message || "Internal error" }, 500);
    }
  }
};