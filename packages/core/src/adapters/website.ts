import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { chromium, type BrowserContext, type Page, type Response, type Route, type WebSocketRoute } from 'playwright';
import { safeFetch, validateTarget } from '@reverse/security';
import { defineAdapter, output } from './base.js';

interface NetworkRecord { method:string; url:string; resourceType:string; status?:number|undefined; size?:number|undefined; durationMs?:number; failed?:string }
interface PageDom {
  title:string; text:string; rawTextChars:number; scripts:string[]; stylesheets:string[]; links:{href:string;text:string}[];
  forms:{method:string;action:string;fields:string[];getUrl?:string}[]; buttons:string[]; explicitButtons:{label:string;url:string}[];
}
interface Candidate { fromUrl:string; url:string; kind:'link'|'form'|'button'; label:string; explicit:boolean; skippedReason?:string }
interface StateTransition { from:string; to:string|null; trigger:string; kind:Candidate['kind']; basis:'EVIDENCE'|'INFERENCE'; observed:boolean; detail:string }
interface WebPage {
  id:string; requestedUrl:string; finalUrl:string; status?:number|undefined; title:string; html:string; text:string;
  scripts:string[]; stylesheets:string[]; links:{href:string;text:string}[]; forms:PageDom['forms']; buttons:string[];
  network:NetworkRecord[]; networkTruncated:boolean; domTruncated:boolean; textTruncated:boolean; screenshot?:string;
}
interface WebAnalysis {
  finalUrl:string; status?:number|undefined; title:string; html:string; text:string; scripts:string[]; stylesheets:string[];
  links:{href:string;text:string}[]; forms:PageDom['forms']; buttons:string[];
  frameworkHints:{name:string;evidence:string;confidence:'INFERENCE'}[];
  network:NetworkRecord[]; screenshot?:string; pages:WebPage[]; stateTransitions:StateTransition[]; candidates:Candidate[];
  compatibility:{index:string;pages:{id:string;url:string;file:string}[];assets:{url:string;file:string;bytes:number}[];limitations:string[]};
  limits:{maxPages:number;maxDomBytes:number;maxNetworkPerPage:number;maxTotalNetwork:number;maxTextChars:number;totalDurationMs:number;maxAssets:number;maxAssetBytes:number};
  limitations:string[]; truncated:boolean; blocked:number; unsafeMethodsBlocked:number; durationMs:number;
}
interface PrepareResult { origin:string; addresses:string[]; allowLocal:boolean }
function transitionKey(fromUrl:string,url:string,kind:Candidate['kind']):string { return JSON.stringify([canonical(fromUrl),canonical(url),kind]); }

const DEFAULTS={maxPages:8,maxDomBytes:2_000_000,maxNetworkPerPage:500,maxTotalNetwork:4000,maxTextChars:100_000,totalDurationMs:120_000,maxAssets:64,maxAssetBytes:2_000_000,maxCandidates:500};
const SENSITIVE_FIELD=/password|passwd|captcha|otp|token|secret|authorization|credential/i;
function browserPath():string|undefined { const candidates=[process.env.RE_CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter((x):x is string=>Boolean(x)); return candidates.find(existsSync); }
function numberOption(value:unknown,fallback:number,min:number,max:number):number { const n=typeof value==='number'&&Number.isFinite(value)?Math.floor(value):fallback; return Math.max(min,Math.min(max,n)); }
function limits(options:Record<string,unknown>):WebAnalysis['limits'] { return {
  maxPages:numberOption(options.maxPages,DEFAULTS.maxPages,1,32), maxDomBytes:numberOption(options.maxDomBytes,DEFAULTS.maxDomBytes,1024,10_000_000),
  maxNetworkPerPage:numberOption(options.maxNetworkPerPage,DEFAULTS.maxNetworkPerPage,1,5000), maxTotalNetwork:numberOption(options.maxTotalNetwork,DEFAULTS.maxTotalNetwork,1,20000),
  maxTextChars:numberOption(options.maxTextChars,DEFAULTS.maxTextChars,100,1_000_000), totalDurationMs:numberOption(options.totalDurationMs,DEFAULTS.totalDurationMs,1000,600_000),
  maxAssets:numberOption(options.maxAssets,DEFAULTS.maxAssets,0,256), maxAssetBytes:numberOption(options.maxAssetBytes,DEFAULTS.maxAssetBytes,1024,10_000_000),
}; }
function canonical(raw:string):string { try { const u=new URL(raw); u.hash=''; return u.toString(); } catch { return raw; } }
const SENSITIVE_QUERY_KEY=/token|secret|password|passwd|auth|signature|api[_-]?key|credential|session|sid|code|key|jwt/i;
function safeUrl(raw:string):string { try { const url=new URL(raw);if(url.username||url.password){url.username='';url.password='';}for(const key of [...url.searchParams.keys()])if(SENSITIVE_QUERY_KEY.test(key))url.searchParams.set(key,'[REDACTED]');url.hash='';return url.toString(); }catch{return '[invalid-url]';} }
function safeReference(raw:string):string { return /^page-\d+$/i.test(raw)?raw:safeUrl(raw); }
function decodeHtmlAttribute(value:string):string { return value.replace(/&(amp|lt|gt|quot|#39|#x27);/gi,(_match,entity:string)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",'#x27':"'"}[entity.toLowerCase()]??_match)).replace(/&#(\d+);/g,(_match,code:string)=>String.fromCodePoint(Number(code))).replace(/&#x([\da-f]+);/gi,(_match,code:string)=>String.fromCodePoint(Number.parseInt(code,16))); }
function safeUrlReference(raw:string):string { try { const value=decodeHtmlAttribute(raw);if(/^[a-z][a-z\d+.-]*:/i.test(value)||value.startsWith('//'))return safeUrl(value);const url=new URL(value,'http://redacted.invalid');for(const key of [...url.searchParams.keys()])if(SENSITIVE_QUERY_KEY.test(key))url.searchParams.set(key,'[REDACTED]');return `${url.pathname}${url.search}`; }catch{return '[invalid-url]';} }
function redactHtmlUrls(html:string):string { return html.replace(/(\b(?:href|src|srcset|poster|background|action|formaction|data|cite|longdesc)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,(_match,prefix:string,doubleQuoted:string|undefined,singleQuoted:string|undefined,unquoted:string|undefined)=>`${prefix}"${htmlEscape(safeUrlReference(doubleQuoted??singleQuoted??unquoted??''))}"`).replace(/https?:\/\/[^\s"'<>]+/gi,value=>htmlEscape(safeUrl(decodeHtmlAttribute(value)))); }
function sameOrigin(raw:string,origin:string):boolean { try { return new URL(raw).origin===origin; } catch { return false; } }
function abortError():Error { return new DOMException('Website capture cancelled','AbortError'); }
function domLimitError():Error { return Object.assign(new Error('DOM size limit exceeded'),{name:'DOMLimitError'}); }
function normalizedHostname(raw:string):string { return raw.replace(/^\[|\]$/g,'').toLowerCase(); }
const LOOPBACK_HOSTS=new BlockList();LOOPBACK_HOSTS.addSubnet('127.0.0.0',8,'ipv4');LOOPBACK_HOSTS.addAddress('::1','ipv6');
function isLoopbackHostname(raw:string):boolean { const host=normalizedHostname(raw);if(host==='localhost'||host.endsWith('.localhost'))return true;const family=isIP(host);return family>0&&LOOPBACK_HOSTS.check(host,family===4?'ipv4':'ipv6'); }
function disposeQuietly(dispose:()=>void|Promise<void>):void { void Promise.resolve().then(dispose).catch(()=>{}); }
function abortable<T>(promise:Promise<T>,signal:AbortSignal,dispose:(value:T)=>void|Promise<void>):Promise<T> {
  if(signal.aborted){promise.then(value=>disposeQuietly(()=>dispose(value)),()=>{});return Promise.reject(abortError());}
  return new Promise<T>((resolve,reject)=>{
    let settled=false;const cleanup=()=>signal.removeEventListener('abort',onAbort);
    const onAbort=()=>{if(settled)return;settled=true;cleanup();reject(abortError());};
    signal.addEventListener('abort',onAbort,{once:true});
    promise.then(value=>{if(settled){disposeQuietly(()=>dispose(value));return;}settled=true;cleanup();if(signal.aborted){disposeQuietly(()=>dispose(value));reject(abortError());}else resolve(value);},error=>{if(settled)return;settled=true;cleanup();reject(signal.aborted?abortError():error);});
  });
}
function htmlEscape(value:string):string { return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
const PREVIEW_CSP='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; media-src \'self\' data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
const DROP_ELEMENTS=new Set(['applet','base','embed','frame','frameset','iframe','math','noembed','noframes','noscript','object','plaintext','portal','svg','template','xmp']);
const VOID_ELEMENTS=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const SAFE_DATA_IMAGE=/^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon)(?:[;,])/i;
const SAFE_DATA_MEDIA=/^data:(?:audio|video)\/[a-z0-9.+-]+(?:[;,])/i;
function sanitizeCss(css:string):string {
  return css.replace(/@import\b[^;]*(?:;|$)/gi,'').replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi,'none').replace(/expression\s*\(/gi,' ').replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi,'');
}
interface HtmlTag { end:number; name:string; closing:boolean; attributes:string; kind:'tag'|'comment'|'doctype'|'discard' }
function readHtmlTag(html:string,start:number):HtmlTag|undefined {
  if(html.startsWith('<!--',start)){const close=html.indexOf('-->',start+4);return {end:close<0?html.length:close+3,name:'',closing:false,attributes:'',kind:'comment'};}
  if(/^<!doctype\b/i.test(html.slice(start,start+10))){let i=start+2;while(i<html.length&&html[i]!=='>')i++;return {end:Math.min(html.length,i+1),name:'',closing:false,attributes:'',kind:'doctype'};}
  if(html.startsWith('<!',start)||html.startsWith('<?',start)){const close=html.indexOf('>',start+2);return {end:close<0?html.length:close+1,name:'',closing:false,attributes:'',kind:'discard'};}
  let i=start+1;let closing=false;if(html[i]==='/'){closing=true;i++;}
  while(i<html.length&&/\s/.test(html[i]!))i++;
  const nameStart=i;while(i<html.length&&/[a-zA-Z0-9:-]/.test(html[i]!))i++;
  if(i===nameStart)return undefined;
  const name=html.slice(nameStart,i).toLowerCase();const attributesStart=i;let quote='';
  while(i<html.length){const char=html[i]!;if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;i++;}
  if(i>=html.length)return undefined;
  return {end:i+1,name,closing,attributes:html.slice(attributesStart,i),kind:'tag'};
}
function parseHtmlAttributes(raw:string):{name:string;value:string}[] {
  const attributes:{name:string;value:string}[]=[];const pattern=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;let match:RegExpExecArray|null;
  while((match=pattern.exec(raw)))attributes.push({name:match[1]!.toLowerCase(),value:match[2]??match[3]??match[4]??''});
  return attributes;
}
function previewUrl(raw:string,baseUrl:string,origin:string,assets:Map<string,string>,pages:Map<string,string>,kind:'page'|'asset'|'image'|'media'):string {
  const clean=raw.trim();if(kind==='image'&&SAFE_DATA_IMAGE.test(clean))return clean;if(kind==='media'&&SAFE_DATA_MEDIA.test(clean))return clean;
  let url:URL;try{url=new URL(clean,baseUrl);}catch{return '';}
  if(url.origin!==origin)return '';
  const local=assets.get(canonical(url.href));if(local)return `./${local}`;
  const page=pages.get(canonical(url.href));return kind==='page'&&page?`./${page}`:'';
}
function sanitizePreviewAttributes(tag:string,raw:string,baseUrl:string,origin:string,assets:Map<string,string>,pages:Map<string,string>):string|null {
  const attributes:{name:string;value:string}[]=[];const seen=new Set<string>();for(const attribute of parseHtmlAttributes(raw)){if(seen.has(attribute.name))continue;seen.add(attribute.name);attributes.push(attribute);}
  const values=new Map(attributes.map(attribute=>[attribute.name,attribute.value]));
  if(tag==='meta'&&values.has('http-equiv'))return null;
  if(tag==='link'&&(values.get('rel')?.trim().toLowerCase()!=='stylesheet'))return null;
  if(tag==='script'){
    const source=previewUrl(values.get('src')??'',baseUrl,origin,assets,pages,'asset');return source?` src="${htmlEscape(source)}"`:null;
  }
  const output:string[]=[];
  if(tag==='form')output.push('action="#compatibility-unavailable"');
  for(const attribute of attributes){
    const name=attribute.name;let value=attribute.value;
    if(name.startsWith('on')||['srcdoc','nonce','target','download','ping','srcset','imagesrcset','longdesc','cite','manifest','profile','archive','codebase','http-equiv'].includes(name))continue;
    if(tag==='form'&&['action','method','enctype'].includes(name))continue;
    if(['action','formaction'].includes(name))value='#compatibility-unavailable';
    else if(name==='style')value=sanitizeCss(value);
    else if(name==='href'){
      if(tag==='a'||tag==='area')value=previewUrl(value,baseUrl,origin,assets,pages,'page');
      else value=previewUrl(value,baseUrl,origin,assets,pages,'asset');
      if(!value)continue;
    }else if(name==='src'){
      const kind=tag==='img'||(tag==='input'&&values.get('type')?.toLowerCase()==='image')?'image':['audio','video','source'].includes(tag)?'media':'asset';
      value=previewUrl(value,baseUrl,origin,assets,pages,kind);if(!value)continue;
    }else if(name==='poster'||name==='background'){value=previewUrl(value,baseUrl,origin,assets,pages,'image');if(!value)continue;}
    else if(name==='data'||name==='xlink:href'){value=previewUrl(value,baseUrl,origin,assets,pages,'asset');if(!value)continue;}
    else if(name==='usemap'&&!value.startsWith('#'))continue;
    output.push(`${name}="${htmlEscape(value)}"`);
  }
  if((tag==='a'||tag==='area'||tag==='link')&&!output.some(attribute=>attribute.startsWith('href=')))return null;
  return output.length?` ${output.join(' ')}`:'';
}
function sanitizePreviewHtml(html:string,baseUrl:string,origin:string,assets:Map<string,string>,pages:Map<string,string>):string {
  let output='';let cursor=0;let droppedTag:string|undefined;let droppedDepth=0;
  while(cursor<html.length){
    const start=html.indexOf('<',cursor);if(start<0){if(!droppedTag)output+=html.slice(cursor);break;}
    if(start>cursor&&!droppedTag)output+=html.slice(cursor,start);
    const token=readHtmlTag(html,start);if(!token){if(!droppedTag)output+='&lt;';cursor=start+1;continue;}
    cursor=token.end;
    if(token.kind==='comment'||token.kind==='discard')continue;
    if(token.kind==='doctype'){if(!droppedTag)output+='<!doctype html>';continue;}
    if(droppedTag){if(token.name===droppedTag){if(token.closing)droppedDepth--;else if(!VOID_ELEMENTS.has(token.name))droppedDepth++;if(droppedDepth===0)droppedTag=undefined;}continue;}
    if(token.closing){if(!DROP_ELEMENTS.has(token.name))output+=`</${token.name}>`;continue;}
    if(DROP_ELEMENTS.has(token.name)){if(!VOID_ELEMENTS.has(token.name)){droppedTag=token.name;droppedDepth=1;}continue;}
    if(token.name==='script'){
      const close=/<\/script\s*>/i.exec(html.slice(cursor));const contentEnd=close?cursor+close.index:html.length;const attributes=sanitizePreviewAttributes(token.name,token.attributes,baseUrl,origin,assets,pages);
      if(attributes)output+=`<script${attributes}></script>`;cursor=close?contentEnd+close[0].length:html.length;continue;
    }
    if(token.name==='style'){
      const close=/<\/style\s*>/i.exec(html.slice(cursor));const contentEnd=close?cursor+close.index:html.length;const css=html.slice(cursor,contentEnd);const attributes=sanitizePreviewAttributes(token.name,token.attributes,baseUrl,origin,assets,pages)??'';
      output+=`<style${attributes}>${sanitizeCss(css)}</style>`;cursor=close?contentEnd+close[0].length:html.length;continue;
    }
    const attributes=sanitizePreviewAttributes(token.name,token.attributes,baseUrl,origin,assets,pages);if(attributes===null)continue;
    output+=`<${token.name}${attributes}>`;
  }
  return output;
}
function redactedWebAnalysis(a:WebAnalysis):WebAnalysis {
  const forms=(values:PageDom['forms'])=>values.map(form=>({method:form.method,action:safeUrl(form.action),fields:form.fields,...(form.getUrl?{getUrl:safeUrl(form.getUrl)}:{})}));
  return {...a,finalUrl:safeUrl(a.finalUrl),html:redactHtmlUrls(a.html),text:redactHtmlUrls(a.text),scripts:a.scripts.map(safeUrl),stylesheets:a.stylesheets.map(safeUrl),links:a.links.map(link=>({href:safeUrl(link.href),text:link.text})),forms:forms(a.forms),network:a.network.map(record=>({...record,url:safeUrl(record.url)})),pages:a.pages.map(page=>({...page,requestedUrl:safeUrl(page.requestedUrl),finalUrl:safeUrl(page.finalUrl),html:redactHtmlUrls(page.html),text:redactHtmlUrls(page.text),scripts:page.scripts.map(safeUrl),stylesheets:page.stylesheets.map(safeUrl),links:page.links.map(link=>({href:safeUrl(link.href),text:link.text})),forms:forms(page.forms),network:page.network.map(record=>({...record,url:safeUrl(record.url)}))})),stateTransitions:a.stateTransitions.map(transition=>({...transition,from:safeReference(transition.from),to:transition.to?safeReference(transition.to):null})),candidates:a.candidates.map(candidate=>({...candidate,fromUrl:safeUrl(candidate.fromUrl),url:candidate.url?safeUrl(candidate.url):''})),compatibility:{...a.compatibility,pages:a.compatibility.pages.map(page=>({...page,url:safeUrl(page.url)})),assets:a.compatibility.assets.map(asset=>({...asset,url:safeUrl(asset.url)}))}};
}

export const websiteAdapter=defineAdapter({
  name:'website',version:'2.0.0',description:'Bounded same-origin multi-page capture with observed state transitions and an offline static compatibility preview.',
  available:async()=>{ const p=browserPath(); return p?{available:true,detail:`Chrome found: ${p}`}:{available:chromium.executablePath()!=='',detail:chromium.executablePath()!==''?'Playwright managed Chromium':'Install Chrome or run npx playwright install chromium'}; },
  detect:async ctx=>{ const target=await validateTarget(ctx.project.target,ctx.options.allowLocal===true,ctx.signal); return {adapter:'website',confidence:1,format:'HTTP website',details:{origin:target.url.origin,resolvedAddresses:target.addresses},limitations:['Only same-origin resources are captured; authentication is not bypassed']}; },
  prepare:async ctx=>{ if(ctx.options.allowLocal===true&&ctx.options.confirmLocal!==true)throw new Error('Local analysis requires confirmLocal=true');const target=await validateTarget(ctx.project.target,ctx.options.allowLocal===true,ctx.signal);return {origin:target.url.origin,addresses:target.addresses,allowLocal:ctx.options.allowLocal===true&&isLoopbackHostname(target.url.hostname)}; },
  analyze:async ctx=>{
    const prep=output<PrepareResult>(ctx,'PREPARE'); const cap=limits(ctx.options); const executablePath=browserPath();
    const hostname=normalizedHostname(new URL(prep.origin).hostname);const address=prep.addresses[0];if(!address)throw new Error('PREPARE did not approve any target address');
    const resolverArgs=isIP(hostname)?[]:[`--host-resolver-rules=MAP ${hostname} ${address.includes(':')?`[${address}]`:address}, MAP * ~NOTFOUND`];
    const started=Date.now(); const deadline=started+cap.totalDurationMs;
    let server:Awaited<ReturnType<typeof chromium.launchServer>>|undefined;let browser:Awaited<ReturnType<typeof chromium.connect>>|undefined;let context:BrowserContext|undefined;let releaseProcess:(()=>void)|undefined;let closePromise:Promise<void>|undefined;const popups=new Set<Page>();
    const closeServer=async(value:Awaited<ReturnType<typeof chromium.launchServer>>)=>{await Promise.allSettled([value.close(),value.kill()]);};
    const closeAll=():Promise<void>=>{if(closePromise)return closePromise;closePromise=(async()=>{await Promise.allSettled([...Array.from(popups,popup=>popup.close()),context?.close(),browser?.close(),...(server?[closeServer(server)]:[])]);})();return closePromise;};
    const onAbort=()=>{void closeAll();};ctx.signal.addEventListener('abort',onAbort,{once:true});
    try {
      ctx.signal.throwIfAborted();
      server=await abortable(chromium.launchServer({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-proxy-server',...resolverArgs]}),ctx.signal,closeServer);
      ctx.signal.throwIfAborted();
      browser=await abortable(chromium.connect(server.wsEndpoint()),ctx.signal,value=>value.close());ctx.signal.throwIfAborted();
      try{const pid=server.process()?.pid;if(typeof pid==='number')releaseProcess=ctx.registerProcess?.(pid);}catch{/* browser exited before registration */}
      ctx.signal.throwIfAborted();
    const pages:WebPage[]=[]; const candidates:Candidate[]=[]; const network:NetworkRecord[]=[]; const networkTargets=new WeakMap<NetworkRecord,string>();const pageNetwork=new Map<Page,NetworkRecord[]>();const truncatedPages=new Set<Page>();
    const visited=new Map<string,string>(); const queued=new Set<string>(); const observedTransitions=new Set<string>(); let blocked=0; let unsafeMethodsBlocked=0;let resourceLimitsExceeded=false;
    const queue:{url:string;kind:Candidate['kind'];label:string;fromUrl:string;explicit:boolean}[]=[{url:canonical(ctx.project.target),kind:'link',label:'initial target',fromUrl:ctx.project.target,explicit:true}];
    queued.add(queue[0]!.url);
    const addCandidate=(c:Candidate)=>{ if(candidates.length>=DEFAULTS.maxCandidates||candidates.some(x=>x.fromUrl===c.fromUrl&&x.url===c.url&&x.kind===c.kind))return; candidates.push(c); };
      context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,ignoreHTTPSErrors:false,javaScriptEnabled:true,acceptDownloads:false});
      const page=await context.newPage();let activeNetwork:NetworkRecord[]=[];
      page.setDefaultTimeout(Math.min(30000,Math.max(1,deadline-Date.now()))); page.setDefaultNavigationTimeout(Math.min(45000,Math.max(1,deadline-Date.now())));
      const pageForRequest=(request:{frame?:()=>{page():Page|null}}):Page=>{try{if(typeof request.frame==='function')return request.frame().page()??page;}catch{/* Popup navigation can precede frame creation. */}const opened=typeof context?.pages==='function'?context.pages():[];for(let index=opened.length-1;index>=0;index--){const candidate=opened[index]!;if(candidate!==page&&!pageNetwork.has(candidate))return candidate;}return page;};
      const routeHandler=async(route:Route)=>{
        const request=route.request(); let url:URL; try{url=new URL(request.url());}catch{blocked++;return route.abort('blockedbyclient');}
        if(url.origin!==prep.origin){blocked++;return route.abort('blockedbyclient');}
        if(!['GET','HEAD','OPTIONS'].includes(request.method())){unsafeMethodsBlocked++;return route.abort('blockedbyclient');}
        const requestPage=pageForRequest(request);const records=pageNetwork.get(requestPage)??[];
        if(records.length>=cap.maxNetworkPerPage||network.length>=cap.maxTotalNetwork){resourceLimitsExceeded=true;truncatedPages.add(requestPage);return route.abort('blockedbyclient');}
        const start=Date.now(); const rawUrl=request.url(); const rec:NetworkRecord={method:request.method(),url:safeUrl(rawUrl),resourceType:request.resourceType()};networkTargets.set(rec,rawUrl);
        records.push(rec); network.push(rec);
        try { await route.continue(); } catch { return; } rec.durationMs=Date.now()-start;
      };
      const webSocketHandler=(socket:WebSocketRoute)=>{try{const url=new URL(socket.url());const origin=url.protocol==='ws:'?`http://${url.host}`:url.protocol==='wss:'?`https://${url.host}`:url.origin;if(origin!==prep.origin){blocked++;void socket.close();return;}if(network.length>=cap.maxTotalNetwork){resourceLimitsExceeded=true;void socket.close();return;}network.push({method:'GET',url:safeUrl(socket.url()),resourceType:'websocket'});}catch{blocked++;void socket.close();}};
      if(typeof context.route==='function')await context.route('**/*',routeHandler);else await page.route('**/*',routeHandler);
      if(typeof context.routeWebSocket==='function')await context.routeWebSocket('**/*',webSocketHandler);else await page.routeWebSocket('**/*',webSocketHandler);
      const recordResponse=(response:Response)=>{ const request=response.request();const records=pageNetwork.get(pageForRequest(request))??[];const rec=records.find(r=>networkTargets.get(r)===request.url()&&r.method===request.method()&&r.status===undefined); if(rec){rec.status=response.status();rec.size=Number(response.headers()['content-length']??0)||undefined;} };
      const recordFailure=(request:{url():string;failure():{errorText?:string}|null;frame?:()=>{page():Page|null}})=>{const records=pageNetwork.get(pageForRequest(request))??[];const rec=records.find(r=>networkTargets.get(r)===request.url()&&r.failed===undefined); if(rec)rec.failed=request.failure()?.errorText??'request failed';};
      let openedPageCount=0;const registerPage=(candidate:Page,popup=false)=>{pageNetwork.set(candidate,pageNetwork.get(candidate)??[]);candidate.on('response',recordResponse);candidate.on('requestfailed',recordFailure);if(popup){popups.add(candidate);candidate.once('close',()=>popups.delete(candidate));}};
      if(typeof context.on==='function')context.on('page',popup=>{openedPageCount++;if(openedPageCount>cap.maxPages){resourceLimitsExceeded=true;void popup.close().catch(()=>{});return;}registerPage(popup,true);});
      openedPageCount=1;registerPage(page);activeNetwork=pageNetwork.get(page)!;
      while(queue.length&&pages.length<cap.maxPages&&Date.now()<deadline){
        ctx.signal.throwIfAborted(); const next=queue.shift()!; const key=canonical(next.url); queued.delete(key);
        if(visited.has(key)){ addCandidate({fromUrl:next.fromUrl,url:key,kind:next.kind,label:next.label,explicit:next.explicit}); continue; }
        pageNetwork.set(page,[]);truncatedPages.delete(page);activeNetwork=pageNetwork.get(page)!;
        const remaining=deadline-Date.now(); if(remaining<=0)break;
        const sourceUrl=page.url();
        const response=await page.goto(key,{waitUntil:'domcontentloaded',timeout:Math.min(45000,remaining)});
        const settle=Math.min(Number(ctx.options.settleMs??800),Math.max(0,deadline-Date.now()));
        if(settle>0)await page.waitForTimeout(settle);
        ctx.signal.throwIfAborted();
        let snapshot:{html?:string;dom?:PageDom}|PageDom;
        try{snapshot=await page.evaluate(limits=>{
          const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);let total=0;
          const add=(value:string,attribute=false):boolean=>{for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code===38)total+=5;else if(code===60||code===62)total+=4;else if(code===34&&attribute)total+=6;else if(code===160)total+=6;else if(code>=0xd800&&code<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){total+=4;i++;}else total+=code<0x80?1:code<0x800?2:3;if(total>limits.maxDom)return false;}return true;};
          const roots:Node[]=Array.from(document.childNodes);const measure=(root:Node):boolean=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_ALL);let node:Node|null=root;while(node){if(node.nodeType===Node.ELEMENT_NODE){const element=node as Element;const name=element.localName;if(!add('<')||!add(name))return false;for(let index=0;index<element.attributes.length;index++){const attribute=element.attributes.item(index)!;if(!add(' ')||!add(attribute.name)||!add('="')||!add(attribute.value,true)||!add('"'))return false;}if(!add('>'))return false;if(!voidTags.has(name)&&(!add('</')||!add(name)||!add('>')))return false;if(element.localName==='template')roots.push((element as HTMLTemplateElement).content);}else if(node.nodeType===Node.TEXT_NODE){if(!add(node.nodeValue??''))return false;}else if(node.nodeType===Node.COMMENT_NODE){if(!add('<!--')||!add(node.nodeValue??'')||!add('-->'))return false;}else if(node.nodeType===Node.DOCUMENT_TYPE_NODE){const doctype=node as DocumentType;if(!add('<!doctype ')||!add(doctype.name))return false;if(doctype.publicId&&(!add(' PUBLIC "')||!add(doctype.publicId,true)||!add('"')))return false;else if(doctype.systemId&&!add(' SYSTEM'))return false;if(doctype.systemId&&(!add(' "')||!add(doctype.systemId,true)||!add('"')))return false;if(!add('>'))return false;}node=walker.nextNode();}return true;};
          while(roots.length){if(total>limits.maxDom||!measure(roots.pop()!))throw new Error('DOM_SIZE_LIMIT_EXCEEDED');}
          const html=document.documentElement.outerHTML;const excluded='script,style,noscript,template';const walkerFor=(root:Node)=>document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest(excluded)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
          const boundedText=(root:Element,limit:number):string=>{let value='';const walker=walkerFor(root);let node:Node|null=walker.nextNode();while(node){const text=node.nodeValue??'';value+=text.slice(0,Math.max(0,limit-value.length));if(value.length>=limit)break;node=walker.nextNode();}return value;};
          let text='';let rawTextChars=0;const walker=walkerFor(document.body??document.documentElement);let node:Node|null=walker.nextNode();while(node){const value=node.nodeValue??'';rawTextChars+=value.length;if(text.length<limits.maxText)text+=value.slice(0,limits.maxText-text.length);node=walker.nextNode();}
          return {html,dom:{
            title:document.title.slice(0,500),text,rawTextChars,
            scripts:Array.from(document.scripts).map(s=>s.src).filter((s):s is string=>Boolean(s)).slice(0,1000),
            stylesheets:Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map(l=>l.href).slice(0,1000),
            links:Array.from(document.querySelectorAll('a[href]')).slice(0,1000).map(a=>({href:(a as HTMLAnchorElement).href,text:boundedText(a,200).trim()})),
            forms:Array.from(document.querySelectorAll('form')).slice(0,100).map(f=>{const form=f as HTMLFormElement;let getUrl:string|undefined;if(form.method.toLowerCase()==='get'){try{const params=new URLSearchParams();new FormData(form).forEach((v,k)=>{if(typeof v==='string')params.append(k,v);});getUrl=new URL(form.action+(form.action.includes('?')?'&':'?')+params.toString(),location.href).href;}catch{}}return {method:form.method,action:form.action,fields:Array.from(form.querySelectorAll('input,textarea,select')).map(i=>i.getAttribute('name')??i.getAttribute('type')??'unnamed').slice(0,100),...(getUrl?{getUrl}:{})};}),
            buttons:Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).slice(0,500).map(b=>(boundedText(b,200).trim()||b.getAttribute('value')||b.getAttribute('aria-label')||'').slice(0,200)).filter(Boolean),
            explicitButtons:Array.from(document.querySelectorAll<HTMLElement>('[data-re-url],[data-re-href]')).slice(0,100).map(b=>{const raw=b.getAttribute('data-re-url')??b.getAttribute('data-re-href')??'';let url='';try{url=new URL(raw,location.href).href;}catch{}return {label:(boundedText(b,200).trim()||b.getAttribute('aria-label')||'explicit state control').slice(0,200),url};}).filter(x=>Boolean(x.url)),
          }};
        },{maxDom:cap.maxDomBytes,maxText:cap.maxTextChars});}catch(error){if(error instanceof Error&&error.message.includes('DOM_SIZE_LIMIT_EXCEEDED'))throw domLimitError();throw error;}
        const atomic=snapshot as {html?:string;dom?:PageDom};const rawHtml=atomic.html??await page.content();if(Buffer.byteLength(rawHtml)>cap.maxDomBytes)throw domLimitError();const html=rawHtml;const dom=atomic.dom??snapshot as PageDom;
        const id=`page-${String(pages.length+1).padStart(4,'0')}`; const finalUrl=page.url(); visited.set(key,id); visited.set(canonical(finalUrl),id);
        if(canonical(sourceUrl)===canonical(next.fromUrl)&&canonical(finalUrl)===key)observedTransitions.add(transitionKey(next.fromUrl,key,next.kind));
        let screenshot:string|undefined;
        if(pages.length===0&&Date.now()<deadline){screenshot='page.png';const image=await page.screenshot({fullPage:false,timeout:Math.min(15000,Math.max(1,deadline-Date.now()))});await ctx.writeArtifact(screenshot,image,'image/png');}
        const captured:WebPage={id,requestedUrl:key,finalUrl,status:typeof response?.status==='function'?response.status():undefined,title:dom.title,html,text:dom.text,scripts:dom.scripts,stylesheets:dom.stylesheets,links:dom.links,forms:dom.forms,buttons:dom.buttons,network:activeNetwork,networkTruncated:truncatedPages.has(page),domTruncated:Buffer.byteLength(rawHtml)>Buffer.byteLength(html),textTruncated:dom.rawTextChars>dom.text.length,...(screenshot?{screenshot}:{})};
        pages.push(captured);
        if(pages.length===1){await ctx.writeArtifact('dom.html',redactHtmlUrls(html),'text/html; charset=utf-8');await ctx.writeArtifact('network.ndjson',network.map(record=>JSON.stringify(record)).join('\n'),'application/x-ndjson');}
        for(const link of dom.links){
          if(!sameOrigin(link.href,prep.origin)){addCandidate({fromUrl:finalUrl,url:link.href,kind:'link',label:link.text,explicit:true,skippedReason:'Cross-origin navigation is not followed'});continue;}
          const target=canonical(link.href); if(!visited.has(target)&&!queued.has(target)&&pages.length+queue.length<cap.maxPages){queued.add(target);queue.push({url:target,kind:'link',label:link.text,fromUrl:finalUrl,explicit:true});}
          addCandidate({fromUrl:finalUrl,url:target,kind:'link',label:link.text,explicit:true});
        }
        for(const form of dom.forms){
          if(form.method.toLowerCase()!=='get'||!form.getUrl){addCandidate({fromUrl:finalUrl,url:form.action,kind:'form',label:`${form.method.toUpperCase()} form`,explicit:false,skippedReason:'Only non-sensitive GET forms are followed'});continue;}
          if(form.fields.some(f=>SENSITIVE_FIELD.test(f))){addCandidate({fromUrl:finalUrl,url:form.getUrl,kind:'form',label:'GET form',explicit:false,skippedReason:'Sensitive or authentication fields are not submitted'});continue;}
          if(!sameOrigin(form.getUrl,prep.origin)){addCandidate({fromUrl:finalUrl,url:form.getUrl,kind:'form',label:'GET form',explicit:false,skippedReason:'Cross-origin form is not followed'});continue;}
          const target=canonical(form.getUrl); if(!visited.has(target)&&!queued.has(target)&&pages.length+queue.length<cap.maxPages){queued.add(target);queue.push({url:target,kind:'form',label:'GET form',fromUrl:finalUrl,explicit:true});}
          addCandidate({fromUrl:finalUrl,url:target,kind:'form',label:'GET form',explicit:true});
        }
        for(const button of dom.explicitButtons){
          if(!sameOrigin(button.url,prep.origin)){addCandidate({fromUrl:finalUrl,url:button.url,kind:'button',label:button.label,explicit:true,skippedReason:'Cross-origin state control is not followed'});continue;}
          const target=canonical(button.url); if(!visited.has(target)&&!queued.has(target)&&pages.length+queue.length<cap.maxPages){queued.add(target);queue.push({url:target,kind:'button',label:button.label,fromUrl:finalUrl,explicit:true});}
          addCandidate({fromUrl:finalUrl,url:target,kind:'button',label:button.label,explicit:true});
        }
        for(const label of dom.buttons)addCandidate({fromUrl:finalUrl,url:'',kind:'button',label,explicit:false,skippedReason:'No explicit same-origin GET state target; click was not guessed'});
      }
      ctx.signal.throwIfAborted();await ctx.writeArtifact('network.ndjson',network.map(record=>JSON.stringify(record)).join('\n'),'application/x-ndjson');
      const stateTransitions:StateTransition[]=candidates.slice(0,DEFAULTS.maxCandidates).map(c=>{const observed=Boolean(c.url&&!c.skippedReason&&observedTransitions.has(transitionKey(c.fromUrl,c.url,c.kind)));const targetVisited=Boolean(c.url&&visited.has(canonical(c.url)));return {from:visited.get(canonical(c.fromUrl))??c.fromUrl,to:c.url?visited.get(canonical(c.url))??null:null,trigger:c.label||c.kind,kind:c.kind,basis:observed?'EVIDENCE':'INFERENCE',observed,detail:c.skippedReason??(observed?'Same-origin GET navigation observed from the candidate source page':targetVisited?'Target captured from another source; this transition was not observed':'Candidate not visited within page/time budget')};});
      const first=pages[0]; if(!first)throw new Error('No page captured before the website budget expired');
      const hints:WebAnalysis['frameworkHints']=[]; const signature=(name:string,pattern:RegExp,evidence:string)=>{if(pattern.test(first.html)||first.scripts.some(s=>pattern.test(s)))hints.push({name,evidence,confidence:'INFERENCE'});};
      signature('React',/__NEXT_DATA__|react(?:-dom)?(?:\.production)?\.js|data-reactroot/i,'DOM or script signature');
      signature('Vue',/data-v-[a-f0-9]{6,}|vue(?:\.runtime)?(?:\.global)?(?:\.prod)?\.js/i,'DOM or script signature');
      signature('Angular',/ng-version=|angular(?:\.min)?\.js/i,'DOM or script signature');
      signature('Next.js',/__NEXT_DATA__|\/_next\/static\//i,'runtime data or asset path');
      const limitations=['Compatibility output is a static snapshot with scripts disabled, not the original backend or a behavioral clone','Only same-origin GET/HEAD/OPTIONS traffic is allowed; authentication, CAPTCHA and POST actions are not bypassed','Buttons without an explicit data-re-url/data-re-href target are recorded but not clicked','Local JavaScript may require APIs that the offline preview intentionally cannot call','Sensitive query values are redacted before persistence; assets that require those values may be unavailable in the offline snapshot'];
      if(pages.length>=cap.maxPages)limitations.push(`Page limit reached (${cap.maxPages})`);
      if(Date.now()>=deadline)limitations.push('Total capture duration limit reached');
      if(resourceLimitsExceeded)limitations.push('Popup or per-page network limit reached');
      const result:WebAnalysis={finalUrl:first.finalUrl,status:first.status,title:first.title,html:first.html,text:first.text,scripts:first.scripts,stylesheets:first.stylesheets,links:first.links,forms:first.forms,buttons:first.buttons,frameworkHints:hints,network,...(first.screenshot?{screenshot:first.screenshot}:{}),pages,stateTransitions,candidates,compatibility:{index:'preview-index.html',pages:[],assets:[],limitations},limits:cap,limitations,truncated:pages.some(p=>p.domTruncated||p.textTruncated||p.networkTruncated)||resourceLimitsExceeded||blocked>0||unsafeMethodsBlocked>0,blocked,unsafeMethodsBlocked,durationMs:Date.now()-started};
      await ctx.log('info',`Captured ${pages.length} pages and ${network.length} same-origin requests; blocked ${blocked} cross-origin and ${unsafeMethodsBlocked} unsafe-method requests`,'playwright');
      return redactedWebAnalysis(result);
    } catch(error){ if(ctx.signal.aborted)throw abortError(); throw error; }
    finally { ctx.signal.removeEventListener('abort',onAbort); await closeAll(); releaseProcess?.(); }
  },
  extractEvidence:async ctx=>{
    const a=output<WebAnalysis>(ctx,'ANALYZE');const safe=redactedWebAnalysis(a);
    await ctx.evidence('VERIFIED','HTTP page response','playwright','response',{url:safe.finalUrl,status:safe.status,title:safe.title});
    await ctx.evidence('EVIDENCE','DOM structure snapshot','playwright','dom.html',{title:safe.title,links:safe.links.length,forms:safe.forms.length,buttons:safe.buttons.length,scripts:safe.scripts,stylesheets:safe.stylesheets,excerpt:safe.html.slice(0,50000)});
    await ctx.evidence('EVIDENCE','Observed same-origin network requests','playwright','network.ndjson',safe.network.slice(0,2000));
    if(safe.screenshot)await ctx.evidence('EVIDENCE','Rendered viewport screenshot','playwright','page.png',{artifact:'page.png',viewport:'1440x1000'});
    for(const page of safe.pages)await ctx.evidence('EVIDENCE',`Page snapshot: ${page.finalUrl}`,'playwright',page.id,{requestedUrl:page.requestedUrl,finalUrl:page.finalUrl,status:page.status,title:page.title,domTruncated:page.domTruncated,networkTruncated:page.networkTruncated,textChars:page.text.length,networkRequests:page.network.length});
    for(const hint of safe.frameworkHints)await ctx.evidence('INFERENCE',`Framework hint: ${hint.name}`,'signature-rules','framework',hint);
    for(const t of safe.stateTransitions)await ctx.evidence(t.basis,`${t.kind} state candidate: ${t.trigger}`,'bounded-navigation','state-transitions',t);
    await ctx.writeArtifact('web-analysis.json',JSON.stringify(safe,null,2),'application/json');
    return {requests:a.network.length,pages:a.pages.length,links:a.links.length,artifacts:['page.png','dom.html','network.ndjson','web-analysis.json']};
  },
  reconstruct:async ctx=>{
    const a=output<WebAnalysis>(ctx,'ANALYZE'); const origin=new URL(a.finalUrl).origin; const assets=new Map<string,string>(); const assetRecords:{url:string;file:string;bytes:number}[]=[];
    const urls=[...new Set(a.pages.flatMap(p=>[...p.scripts,...p.stylesheets]))].filter(u=>sameOrigin(u,origin)).slice(0,a.limits.maxAssets); const assetDeadline=Date.now()+a.limits.totalDurationMs;
    let approved:{addresses:string[];allowLocal:boolean}|undefined;if(urls.length){const prep=output<PrepareResult>(ctx,'PREPARE');if(new URL(prep.origin).origin!==origin)throw new Error('PREPARE origin does not match the captured pages');if(!prep.addresses.length)throw new Error('PREPARE did not approve any target address');approved={addresses:[...prep.addresses],allowLocal:prep.allowLocal===true&&isLoopbackHostname(new URL(prep.origin).hostname)};}
    for(const [index,url] of urls.entries()){
      ctx.signal.throwIfAborted(); const remaining=assetDeadline-Date.now();if(remaining<=0)break;try{
        if(!approved)throw new Error('Missing approved target addresses');
        const response=await safeFetch(url,{...approved,signal:ctx.signal,maxBytes:a.limits.maxAssetBytes,timeoutMs:Math.min(20000,remaining)});
        if(!sameOrigin(response.finalUrl,origin))continue;
        const ext=new URL(url).pathname.toLowerCase().endsWith('.css')?'css':'js'; const file=`preview-asset-${String(index+1).padStart(4,'0')}.${ext}`;
        if(response.truncated)continue;
        const body=ext==='css'?Buffer.from(sanitizeCss(response.body.toString('utf8')),'utf8'):response.body;
        await ctx.writeArtifact(file,body,ext==='css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8'); assets.set(canonical(url),file); assetRecords.push({url:safeUrl(url),file,bytes:body.length});
      }catch{if(ctx.signal.aborted)throw abortError();/* A missing optional asset must not prevent the static snapshot from being emitted. */}
    }
    const pageFiles=new Map<string,string>(); const previewPages:{id:string;url:string;file:string}[]=[];
    for(const page of a.pages){const file=`preview-${page.id}.html`;pageFiles.set(canonical(page.finalUrl),file);pageFiles.set(canonical(page.requestedUrl),file);previewPages.push({id:page.id,url:safeUrl(page.finalUrl),file});}
    const snapshotHtml=(page:WebPage):string=>{
      const html=sanitizePreviewHtml(page.html,page.finalUrl,origin,assets,pageFiles);
      if(/<head\b[^>]*>/i.test(html))return html.replace(/<head\b[^>]*>/i,m=>`${m}${PREVIEW_CSP}`);
      if(/<body\b[^>]*>/i.test(html))return html.replace(/<body\b[^>]*>/i,m=>`<head>${PREVIEW_CSP}</head>${m}`);
      return `<!doctype html><html><head>${PREVIEW_CSP}</head><body>${html}</body></html>`;
    };
    for(const page of a.pages){ctx.signal.throwIfAborted();const file=`preview-${page.id}.html`;await ctx.writeArtifact(file,snapshotHtml(page),'text/html; charset=utf-8');}
    const items=previewPages.map(p=>`<li><a href="./${p.file}">${htmlEscape(p.url)}</a><iframe title="${htmlEscape(p.url)}" src="./${p.file}" sandbox="" loading="lazy" referrerpolicy="no-referrer"></iframe></li>`).join('');
    const index=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>独立静态兼容预览</title><style>body{font:15px system-ui;background:#0b121b;color:#e7f1f7;margin:0;padding:24px}li{list-style:none;margin:0 0 28px}a{color:#65b5ff}iframe{display:block;width:100%;height:480px;margin-top:10px;border:1px solid #294056;background:white}p{color:#9bb0c2}</style></head><body><h1>独立静态兼容预览</h1><p>这是从观察证据生成的静态快照，不是原始后端恢复。脚本网络请求与表单提交已被隔离。</p><ol>${items}</ol></body></html>`;
    await ctx.writeArtifact('preview-index.html',index,'text/html; charset=utf-8');
    a.compatibility={index:'preview-index.html',pages:previewPages,assets:assetRecords,limitations:a.limitations};
    await ctx.writeArtifact('web-compatibility.json',JSON.stringify(a.compatibility,null,2),'application/json');
    await ctx.evidence('INFERENCE','Bounded page state model','bounded-navigation','state-transitions',a.stateTransitions);
    await ctx.evidence('VERIFIED','Static compatibility snapshot generated with scripts disabled','reconstruction-generator','preview-index.html',{pages:previewPages.length,localAssets:assetRecords.length,staticSnapshot:true,scriptExecutionDisabled:true,originalBackendRecovered:false});
    return {reconstructed:true,files:['preview-index.html','web-compatibility.json',...previewPages.map(p=>p.file),...assetRecords.map(x=>x.file)],limitations:a.limitations};
  },
  validate:async ctx=>{
    const a=output<WebAnalysis>(ctx,'ANALYZE'); const rec=output<{reconstructed:boolean;files?:string[];limitations?:string[]}|undefined>(ctx,'RECONSTRUCT');
    const checks=[{name:'At least one page captured within maxPages',passed:a.pages.length>0&&a.pages.length<=a.limits.maxPages,details:`${a.pages.length}/${a.limits.maxPages}`},{name:'Per-page network limits respected',passed:a.pages.every(p=>p.network.length<=a.limits.maxNetworkPerPage)&&a.network.length<=a.limits.maxTotalNetwork},{name:'Per-page DOM and text limits respected',passed:a.pages.every(p=>Buffer.byteLength(p.html)<=a.limits.maxDomBytes&&p.text.length<=a.limits.maxTextChars)},{name:'Standalone preview generated',passed:rec?.reconstructed===true&&Boolean(rec.files?.includes('preview-index.html'))},{name:'Original backend is not claimed',passed:rec?.limitations?.some(x=>x.includes('not the original backend'))??false}];
    const passed=checks.every(c=>c.passed); await ctx.writeArtifact('validation.json',JSON.stringify({passed,checks,limitations:a.limitations},null,2),'application/json'); return {passed,checks,limitations:a.limitations};
  }
});
