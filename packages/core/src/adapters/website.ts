import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { chromium } from 'playwright';
import { validateTarget } from '@reverse/security';
import { defineAdapter, noReconstruction, output } from './base.js';

interface NetworkRecord { method:string; url:string; resourceType:string; status?:number|undefined; size?:number|undefined; durationMs?:number; failed?:string }
interface WebAnalysis { finalUrl:string; status?:number|undefined; title:string; html:string; text:string; scripts:string[]; stylesheets:string[]; links:{href:string;text:string}[]; forms:{method:string;action:string;fields:string[]}[]; buttons:string[]; frameworkHints:{name:string;evidence:string;confidence:'INFERENCE'}[]; network:NetworkRecord[]; screenshot?:string; limitations:string[]; truncated:boolean }
function browserPath():string|undefined { const candidates=[process.env.RE_CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter((x):x is string=>Boolean(x)); return candidates.find(existsSync); }
export const websiteAdapter=defineAdapter({
  name:'website',version:'1.0.0',description:'Authorized same-origin browser capture: DOM, scripts, routes, forms, screenshot and network metadata.',
  available:async()=>{ const p=browserPath(); return p?{available:true,detail:`Chrome found: ${p}`}:{available:chromium.executablePath()!=='',detail:chromium.executablePath()!==''?'Playwright managed Chromium':'Install Chrome or run npx playwright install chromium'}; },
  detect:async ctx=>{ const target=await validateTarget(ctx.project.target,ctx.options.allowLocal===true); return {adapter:'website',confidence:1,format:'HTTP website',details:{origin:target.url.origin,resolvedAddresses:target.addresses},limitations:['Only same-origin resources are captured; authentication is not bypassed']}; },
  prepare:async ctx=>{ const target=await validateTarget(ctx.project.target,ctx.options.allowLocal===true); if(ctx.options.allowLocal===true&&ctx.options.confirmLocal!==true) throw new Error('Local analysis requires confirmLocal=true'); return {origin:target.url.origin,addresses:target.addresses,activeInteraction:false}; },
  analyze:async ctx=>{
    const prep=output<{origin:string;addresses:string[]}>(ctx,'PREPARE');
    const executablePath=browserPath();
    const hostname=new URL(prep.origin).hostname;
    const resolverArgs=isIP(hostname)?[]:[`--host-resolver-rules=MAP * ~NOTFOUND, MAP ${hostname} ${prep.addresses[0]}`];
    const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-dev-shm-usage','--disable-gpu','--no-first-run',...resolverArgs]});
    const started=Date.now();
    try {
      const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,ignoreHTTPSErrors:false,javaScriptEnabled:true});
      const page=await context.newPage();
      page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(45000);
      const network:NetworkRecord[]=[];
      let blocked=0;
      await page.route('**/*',async route=>{
        const request=route.request(); const url=new URL(request.url());
        if(url.origin!==prep.origin) { blocked++; return route.abort('blockedbyclient'); }
        const start=Date.now();
        try { await route.continue(); } catch { return; }
        network.push({method:request.method(),url:request.url(),resourceType:request.resourceType(),durationMs:Date.now()-start});
      });
      page.on('response',response=>{ const request=response.request(); const rec=network.find(r=>r.url===request.url()&&r.method===request.method()&&r.status===undefined); if(rec){ rec.status=response.status(); rec.size=Number(response.headers()['content-length']??0)||undefined; } else network.push({method:request.method(),url:request.url(),resourceType:request.resourceType(),status:response.status()}); });
      page.on('requestfailed',request=>{ const rec=network.find(r=>r.url===request.url()&&r.failed===undefined); if(rec) rec.failed=request.failure()?.errorText??'request failed'; });
      const response=await page.goto(ctx.project.target,{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForTimeout(Number(ctx.options.settleMs??800));
      const html=(await page.content()).slice(0,2_000_000);
      const dom=await page.evaluate(()=>({
        title:document.title,
        text:document.body?.innerText.slice(0,100000)??'',
        scripts:Array.from(document.scripts).map(s=>s.src).filter((s):s is string=>Boolean(s)),
        stylesheets:Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map(l=>l.href),
        links:Array.from(document.querySelectorAll('a[href]')).slice(0,1000).map(a=>({href:(a as HTMLAnchorElement).href,text:(a as HTMLAnchorElement).innerText.trim().slice(0,200)})),
        forms:Array.from(document.querySelectorAll('form')).slice(0,100).map(f=>({method:f.method,action:f.action,fields:Array.from(f.querySelectorAll('input,textarea,select')).map(i=>i.getAttribute('name')??i.getAttribute('type')??'unnamed').slice(0,100)})),
        buttons:Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).slice(0,500).map(b=>b.textContent?.trim()||b.getAttribute('value')||b.getAttribute('aria-label')||'').filter(Boolean),
        generator:document.querySelector('meta[name=generator]')?.getAttribute('content')??''
      }));
      const hints:WebAnalysis['frameworkHints']=[];
      const signature=(name:string,pattern:RegExp,evidence:string)=>{ if(pattern.test(html)||dom.scripts.some(s=>pattern.test(s))) hints.push({name,evidence,confidence:'INFERENCE'}); };
      signature('React',/__NEXT_DATA__|react(?:-dom)?(?:\.production)?\.js|data-reactroot/i,'DOM or script signature');
      signature('Vue',/data-v-[a-f0-9]{6,}|vue(?:\.runtime)?(?:\.global)?(?:\.prod)?\.js/i,'DOM or script signature');
      signature('Angular',/ng-version=|angular(?:\.min)?\.js/i,'DOM or script signature');
      signature('Next.js',/__NEXT_DATA__|\/_next\/static\//i,'runtime data or asset path');
      const screenshot='page.png'; await page.screenshot({path:`${ctx.artifactDir}/${screenshot}`,fullPage:false,timeout:15000});
      await ctx.writeArtifact(screenshot,await (await import('node:fs/promises')).readFile(`${ctx.artifactDir}/${screenshot}`),'image/png');
      await ctx.writeArtifact('dom.html',html,'text/html; charset=utf-8');
      await ctx.writeArtifact('network.ndjson',network.map(n=>JSON.stringify(n)).join('\n'),'application/x-ndjson');
      const result:WebAnalysis={finalUrl:page.url(),status:response?.status(),title:dom.title,html,text:dom.text,scripts:dom.scripts,stylesheets:dom.stylesheets,links:dom.links,forms:dom.forms,buttons:dom.buttons,frameworkHints:hints,network,screenshot,limitations:['Single-page capture; multi-page state machine reconstruction is not implemented','Response bodies, cookies and authorization headers are not saved','Framework hints are signatures, not confirmed framework versions'],truncated:blocked>0};
      await ctx.log('info',`Captured ${network.length} same-origin requests; blocked ${blocked} cross-origin subresources`,'playwright');
      return result;
    } finally { await browser.close(); void started; }
  },
  extractEvidence:async ctx=>{
    const a=output<WebAnalysis>(ctx,'ANALYZE');
    await ctx.evidence('VERIFIED','HTTP page response','playwright','response',{url:a.finalUrl,status:a.status,title:a.title});
    await ctx.evidence('EVIDENCE','DOM structure snapshot','playwright','dom.html',{title:a.title,links:a.links.length,forms:a.forms.length,buttons:a.buttons.length,scripts:a.scripts,stylesheets:a.stylesheets,excerpt:a.html.slice(0,50000)});
    await ctx.evidence('EVIDENCE','Observed same-origin network requests','playwright','network.ndjson',a.network.slice(0,2000));
    await ctx.evidence('EVIDENCE','Rendered viewport screenshot','playwright','page.png',{artifact:'page.png',viewport:'1440x1000'});
    for(const hint of a.frameworkHints) await ctx.evidence('INFERENCE',`Framework hint: ${hint.name}`,'signature-rules','framework',hint);
    await ctx.evidence('INFERENCE','Route candidates','link-analysis','routes',a.links.map(l=>l.href).filter((v,i,s)=>s.indexOf(v)===i).slice(0,500));
    await ctx.writeArtifact('web-analysis.json',JSON.stringify(a,null,2),'application/json');
    return {requests:a.network.length,links:a.links.length,artifacts:['page.png','dom.html','network.ndjson','web-analysis.json']};
  },
  reconstruct:async ctx=>{ await ctx.evidence('UNKNOWN','Automatic website cloning is not enabled','website-adapter','reconstruct',{reason:'v0.0.1 captures evidence; visual/behavior reconstruction is roadmap v0.0.3'}); return noReconstruction(ctx,'No runnable website clone was generated'); },
  validate:async ctx=>{ const a=output<WebAnalysis>(ctx,'ANALYZE'); const checks=[{name:'HTTP response captured',passed:Boolean(a.status)},{name:'DOM snapshot captured',passed:a.html.length>0},{name:'Screenshot artifact captured',passed:Boolean(a.screenshot)},{name:'Network metadata captured',passed:Array.isArray(a.network)}]; return {passed:checks.every(c=>c.passed),checks,limitations:a.limitations}; }
});
