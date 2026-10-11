// Minimal tap-friendly page for human checks (hCaptcha etc.). Serves a
// screenshot cropped to the captcha frame, maps taps back to page
// coordinates, and refreshes itself. Mounted under the viewer gateway's
// /open?next=/human authenticated redirect so it works over the tunnel too.

const HTML = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Harklet check</title>
<style>body{margin:0;background:#111;color:#eee;font:14px sans-serif;text-align:center}
#wrap{position:relative;display:inline-block;margin-top:8px;overflow:hidden;touch-action:manipulation}
img{display:block;image-rendering:auto;user-select:none;-webkit-user-drag:none}
#bar{padding:6px;font-size:12px;color:#aaa}a{color:#8ab4ff}button{font-size:16px;padding:8px 14px;margin:4px}</style>
<div id=wrap><img id=shot></div>
<div id=bar><span id=st>loading…</span> · <a id=full href=#>full screen</a> · <button id=re>refresh</button></div>
<script>
let page={w:1280,h:800},box=null,scale=1,fullMode=false;
const img=document.getElementById('shot'),wrap=document.getElementById('wrap'),st=document.getElementById('st');
async function poll(){
 try{const b=await(await fetch(fullMode?'/human/box?full=1&t='+Date.now():'/human/box?t='+Date.now())).json();
  page={w:b.w||1280,h:b.h||800};box=b.box;
  scale=Math.min(innerWidth-8,box?box.w:page.w)/(box?box.w:page.w)||1;
  if(box){wrap.style.width=(box.w*scale)+'px';wrap.style.height=(box.h*scale)+'px';
    img.style.width=(page.w*scale)+'px';img.style.marginLeft=(-box.x*scale)+'px';img.style.marginTop=(-box.y*scale)+'px';}
  else{wrap.style.width=(page.w*scale)+'px';wrap.style.height='auto';
    img.style.width=(page.w*scale)+'px';img.style.margin='0';}
  st.textContent=box?'highlighted area — tap inside':(fullMode?'full page':'no captcha found — showing full page');
 }catch(e){st.textContent='connection lost…retrying'}
 img.src='/human/shot?t='+Date.now();
}
img.addEventListener('click',async e=>{
 const r=img.getBoundingClientRect();
 const x=Math.round((e.clientX-r.left)/scale),y=Math.round((e.clientY-r.top)/scale);
 st.textContent='tap sent ('+x+','+y+')';
 await fetch('/human/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x,y})}).catch(()=>{});
 setTimeout(poll,700);
});
document.getElementById('re').onclick=poll;
document.getElementById('full').onclick=e=>{e.preventDefault();fullMode=!fullMode;document.getElementById('full').textContent=fullMode?'zoom to captcha':'full screen';poll()};
poll();setInterval(poll,2500);
</scr`+`ipt>`;

export function humanRoutes(ops) {
  // ops: { shot(): {png_base64,width,height} (jpeg), click(x,y), box(): {w,h,box}, interactive }
  const readBody = req => new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); });
  return async (req, res, url) => {
    const send = (code, body, type) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
      res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      res.end(buf);
    };
    if (url.pathname === '/human') return send(200, HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/human/shot') {
      const s = await ops.shot();
      return send(200, Buffer.from(s.png_base64, 'base64'), 'image/jpeg');
    }
    if (url.pathname === '/human/box') {
      const b = await ops.box().catch(() => null);
      if (b && url.searchParams.get('full')) b.box = null;
      return send(200, JSON.stringify(b ?? { w: 1280, h: 800, box: null }), 'application/json');
    }
    if (url.pathname === '/human/click' && req.method === 'POST') {
      if (!ops.interactive) return send(403, 'view only', 'text/plain');
      const b = JSON.parse((await readBody(req)) || '{}');
      const x = Math.max(0, Math.min(4000, Number(b.x) || 0));
      const y = Math.max(0, Math.min(4000, Number(b.y) || 0));
      await ops.click(x, y).catch(() => {});
      return send(204, '', 'text/plain');
    }
    return send(404, 'not found', 'text/plain');
  };
}
