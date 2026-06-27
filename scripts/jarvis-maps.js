#!/opt/homebrew/bin/node
'use strict';
const { createSign } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const TEAM_ID = '<apple-team-id>';

function readKeychain(service) {
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-a', 'jarvis', '-w']);
  if (r.status !== 0) throw new Error('Keychain ' + service + ' not found');
  let v = r.stdout.toString().trim();
  if (!v.startsWith('-----') && /^[0-9A-Fa-f]+$/.test(v.replace(/\s/g, ''))) {
    v = Buffer.from(v.replace(/\s/g, ''), 'hex').toString('utf8').trim();
  }
  return v;
}

function makeJwt(keyId, mapsId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg:'ES256', kid:keyId, typ:'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss:TEAM_ID, iat:now, exp:now+1800, sub:mapsId })).toString('base64url');
  const input = h + '.' + p;
  const s = createSign('SHA256');
  s.update(input);
  return input + '.' + s.sign({ key: pem, dsaEncoding:'ieee-p1363' }).toString('base64url');
}

function post(url, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method:'POST', headers, timeout:10000 }, r => {
      let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ if(r.statusCode<300) try{res(JSON.parse(b))}catch{res(b)} else rej(new Error('HTTP '+r.statusCode+': '+b.slice(0,200))); });
    });
    req.on('timeout',()=>{req.destroy();rej(new Error('timeout'))});
    req.on('error',rej); req.end();
  });
}

function get(url, headers) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers, timeout:10000 }, r => {
      let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ if(r.statusCode<300) try{res(JSON.parse(b))}catch{res(b)} else rej(new Error('HTTP '+r.statusCode+': '+b.slice(0,200))); });
    });
    req.on('timeout',()=>{req.destroy();rej(new Error('timeout'))});
    req.on('error',rej);
  });
}

async function token(jwt) {
  const d = await post('https://maps-api.apple.com/v1/token', { Authorization:'Bearer '+jwt, 'Content-Type':'application/json' });
  if (!d.accessToken) throw new Error('token exchange failed: '+JSON.stringify(d));
  return d.accessToken;
}

async function geo(tok, addr) {
  const d = await get('https://maps-api.apple.com/v1/geocode?q='+encodeURIComponent(addr)+'&lang=en-US', { Authorization:'Bearer '+tok });
  const r = d.results?.[0]; if (!r) throw new Error('no geocode for: '+addr);
  return { lat:r.coordinate.lat, lng:r.coordinate.lng, label:(r.displayLines||[]).join(', ')||addr };
}

const ft = s => s<60?s+'s':s<3600?Math.round(s/60)+'min':Math.floor(s/3600)+'h'+Math.round((s%3600)/60)+'min';
const fd = m => (m/1609.344).toFixed(1)+' miles';

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (!cmd) { console.log('Usage: jarvis-maps <eta|search|directions|geocode> [args]'); process.exit(1); }
  const keyId = readKeychain('jarvis-maps-key-id');
  const mapsId = readKeychain('jarvis-maps-id');
  let pem = readKeychain('jarvis-maps-private-key');
  if (!pem.startsWith('-----') && /^[0-9A-Fa-f]+$/.test(pem.replace(/\s/g, ''))) {
    pem = Buffer.from(pem.replace(/\s/g, ''), 'hex').toString('utf8').trim();
  }
  if (!pem.startsWith('-----BEGIN')) throw new Error('PEM decode failed, starts with: ' + pem.slice(0,30));
  const jwt = makeJwt(keyId, mapsId, pem);
  const tok = await token(jwt);

  if (cmd === 'eta') {
    const [o, d, mode='Automobile'] = a;
    if (!o||!d) return console.log('Usage: jarvis-maps eta <origin> <dest> [mode]');
    const [og, dg] = await Promise.all([geo(tok,o), geo(tok,d)]);
    const etaData = await get('https://maps-api.apple.com/v1/eta?origin='+og.lat+','+og.lng+'&destinations='+dg.lat+','+dg.lng+'&transportType='+mode, { Authorization:'Bearer '+tok });
    const r = etaData.etas?.[0];
    if (!r) return console.log('No ETA result. API response: '+JSON.stringify(etaData).slice(0,200));
    console.log('From: '+og.label+'\nTo:   '+dg.label+'\nETA:  '+ft(r.expectedTravelTimeSeconds)+' — '+fd(r.distanceMeters)+' via '+mode);
    if (r.staticTravelTimeSeconds && r.staticTravelTimeSeconds !== r.expectedTravelTimeSeconds)
      console.log('Traffic: +'+ft(r.expectedTravelTimeSeconds-r.staticTravelTimeSeconds)+' over baseline '+ft(r.staticTravelTimeSeconds));
  } else if (cmd === 'search') {
    const [q] = a; if (!q) return console.log('Usage: jarvis-maps search <query>');
    const rs = (await get('https://maps-api.apple.com/v1/search?q='+encodeURIComponent(q)+'&limitToCountries=US&lang=en-US', { Authorization:'Bearer '+tok })).results||[];
    if (!rs.length) return console.log('No results.');
    rs.slice(0,5).forEach((r,i)=>{ console.log((i+1)+'. '+(r.displayLines||[r.name]).join(' — ')); const addr=(r.formattedAddressLines||[]).join(', '); if(addr)console.log('   '+addr); if(r.coordinate?.lat!=null)console.log('   '+r.coordinate.lat.toFixed(5)+', '+r.coordinate.lng.toFixed(5)); });
  } else if (cmd === 'directions') {
    const [o, d, mode='Automobile'] = a;
    if (!o||!d) return console.log('Usage: jarvis-maps directions <origin> <dest> [mode]');
    const [og, dg] = await Promise.all([geo(tok,o), geo(tok,d)]);
    const route = (await get('https://maps-api.apple.com/v1/directions?origin='+og.lat+','+og.lng+'&destination='+dg.lat+','+dg.lng+'&transportType='+mode+'&lang=en-US', { Authorization:'Bearer '+tok })).routes?.[0];
    if (!route) return console.log('No route found.');
    console.log('From: '+og.label+'\nTo:   '+dg.label+'\n'+fd(route.distanceMeters)+' — '+ft(route.expectedTravelTimeSeconds)+' via '+mode+'\n');
    (route.legs?.[0]?.steps||[]).slice(0,20).forEach((s,i)=>{ const t=s.instructions||s.description||''; if(t)console.log((i+1)+'. '+t); });
  } else if (cmd === 'geocode') {
    const [addr] = a; if (!addr) return console.log('Usage: jarvis-maps geocode <address>');
    const r = await geo(tok, addr); console.log(r.label+'\n'+r.lat+', '+r.lng);
  } else { console.log('Unknown: '+cmd); process.exit(1); }
}

main().catch(e => { console.error('Error: '+e.message); process.exit(1); });
