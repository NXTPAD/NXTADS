const $=s=>document.querySelector(s);const $=s=>[...document.querySelectorAll(s)];let connectedAccounts=[];
function showPage(id){$$(".page").forEach(x=>x.classList.toggle("hidden",x.id!==id));$$(".nav").forEach(x=>x.classList.toggle("active",x.dataset.page===id));window.scrollTo({top:0,behavior:"smooth"})}
$$(".nav").forEach(b=>b.onclick=()=>showPage(b.dataset.page));
function modal(open){$("#modal").classList.toggle("hidden",!open)}
$("#newCampaign").onclick=()=>modal(true);$("#newCampaign2").onclick=()=>modal(true);$("#closeModal").onclick=()=>modal(false);
$("#generate").onclick=async()=>{
  const status=$("#aiStatus");status.textContent="Generating…";
  const body={business:$("#business").value,offer:$("#offer").value,audience:$("#audience").value,objective:$("#objective").value};
  try{
    const r=await fetch("/api/ai/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json();if(d.error)throw Error(d.error);
    $("#creative").innerHTML=`<div class="creative-card"><div class="eyebrow">PRIMARY VARIANT</div><h3>${esc(d.headline)}</h3><p>${esc(d.description)}</p><button>${esc(d.cta||"Learn More")}</button></div>${(d.variants||[]).map((v,i)=>`<div class="creative-card"><div class="eyebrow">VARIANT ${i+1}</div><h3>${esc(v.headline)}</h3><p>${esc(v.description)}</p><button>${esc(v.cta||"Learn More")}</button></div>`).join("")}`;
    status.textContent=d.note?"Preview":"Generated";status.style.color="#26cfa9";
  }catch(e){status.textContent="Error";$("#creative").innerHTML=`<div class="empty">${esc(e.message)}</div>`}
};
$("#createCampaign").onclick=async()=>{const msg=$("#modalMsg");msg.textContent="Creating…";try{const budget=Math.round(Number($("#cBudget").value||0)*100);const r=await fetch("/api/campaigns",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:$("#cName").value,budget_cents:budget,objective:$("#cObjective").value,website_url:$("#cUrl").value})});const d=await r.json();if(d.error)throw Error(d.error);const ar=await fetch("/api/ads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:d.id,provider:"google",headline:$("#cHeadline").value||$("#cName").value,description:$("#cDescription").value||"Learn more and get started today.",cta:$("#cCta").value||"Get Started"})});const ad=await ar.json();if(ad.error)throw Error(ad.error);msg.textContent="Draft created. NXT fee: $"+(d.fee_cents/100).toFixed(2)+". Total if funded: $"+(d.total_cents/100).toFixed(2)+".";loadCampaigns()}catch(e){msg.textContent=e.message}};
async function loadCampaigns(){
try{const r=await fetch("/api/campaigns");const d=await r.json();if(!Array.isArray(d))return;const google=connectedAccounts.find(a=>a.provider==="google");
$("#campaignList").innerHTML=d.length?d.map(c=>"<div class=\"campaign-row\"><div><b>"+esc(c.name)+"</b><small>"+esc(c.objective)+"</small></div><div><small>Budget</small><b>$"+(c.budget_cents/100).toLocaleString()+"</b></div><div><small>NXT fee</small><b>$"+(c.fee_cents/100).toLocaleString()+"</b></div><div><small>Status</small><b>"+esc(c.status)+"</b></div><div>"+(google&&c.status==="draft"?'<button class="primary mini-btn" onclick="publishGoogle(\''+c.id+'\',\''+google.id+'\')">Publish</button>':"")+"</div></div>").join(""):"<div class=\"empty\">No campaigns yet. Create your first campaign.</div>"}catch{$("#campaignList").innerHTML="<div class=\"empty\">Unable to load campaigns.</div>"}}
async function publishGoogle(campaignId,accountId){if(!confirm("Publish this campaign to the connected Google Ads account? It will be created PAUSED for review."))return;try{const r=await fetch("/api/campaigns/"+campaignId+"/publish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"google",ad_account_id:accountId})});const d=await r.json();if(d.error)throw Error(d.error);alert("Campaign created in Google Ads as PAUSED. Resource: "+d.campaign_resource);loadCampaigns()}catch(e){alert(e.message)}}
async function loadProviders(){try{const r=await fetch("/api/providers");const d=await r.json();$("#providerGrid").innerHTML=d.providers.map(p=>`<div class="panel provider"><div class="provider-icon">◈</div><h3>${esc(p.name)}</h3><p>${p.configured?"Credentials detected and ready for OAuth.":"Add provider credentials in Cloudflare Secrets to enable this connection."}</p><button class="primary" data-provider="${p.id}">${p.configured?"Connect":"Configure"}</button></div>`).join("");$("[data-provider]").forEach(b=>b.onclick=()=>{const p=b.dataset.provider;if(p)location.href="/api/providers/"+p+"/connect"})}catch{}}
async function loadAccounts(){
  try{
    const r=await fetch("/api/accounts"),d=await r.json();
    const el=$("#accountList"); if(!el)return;
    if(d.error && !(d.accounts||[]).length){el.innerHTML='<div class="empty">'+esc(d.error)+'</div>';return}
    connectedAccounts=d.accounts||[];el.innerHTML=(d.accounts||[]).map(a=>'<div class="campaign-row"><div><b>'+esc(a.account_name||a.provider)+'</b><small>'+esc(a.provider.toUpperCase())+'</small></div><div><small>Account</small><b>'+esc(a.external_id||"—")+'</b></div><div><small>Status</small><b>'+esc(a.status)+'</b></div></div>').join("")||'<div class="empty">Connect an advertising network to see accounts here.</div>';
  }catch(e){}
}
async function loadAuth(){
  try{
    const r=await fetch("/api/auth/me"); const d=await r.json();
    const name=document.querySelector("#profileName"), status=document.querySelector("#profileStatus"), btn=document.querySelector("#loginBtn");
    if(d.authenticated){
      name.textContent=d.user?.name||d.user?.email||"NXT User"; status.textContent=d.user?.email||"Signed in"; btn.textContent="Sign out";
      btn.onclick=async()=>{await fetch("/api/auth/logout",{method:"POST"});location.reload()};
    }else{
      btn.textContent="Sign in"; btn.onclick=()=>location.href="/api/auth/google";
    }
  }catch(e){}
}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
loadAuth();loadCampaigns();loadProviders();loadAccounts();