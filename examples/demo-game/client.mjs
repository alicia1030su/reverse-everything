import WebSocket from 'ws';
const url=process.argv[2]??'ws://127.0.0.1:3200';
const socket=new WebSocket(url);const pending=new Map();
function waitFor(type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`timeout: ${type}`)),5000);pending.set(type,{resolve,reject,timer});});}
function send(type,payload={}){socket.send(JSON.stringify({type,...payload}));}
socket.on('message',raw=>{const message=JSON.parse(raw.toString());console.log('←',JSON.stringify(message));const item=pending.get(message.type);if(item){clearTimeout(item.timer);pending.delete(message.type);item.resolve(message);}});
await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
const welcomeWait=waitFor('welcome');send('hello',{protocol:1});const welcome=await welcomeWait;if(welcome.type!=='welcome')throw new Error('Handshake failed');
const loginWait=waitFor('login_ok');const loginStateWait=waitFor('player_state');send('login',{username:'tester'});await loginWait;await loginStateWait;
const moveWait=waitFor('player_state');send('move',{dx:1});const state=await moveWait;if(state.xp!==10)throw new Error('Move state mismatch');
const logoutWait=waitFor('logout_ok');send('logout',{});await logoutWait;socket.close();console.log('✓ Client flow completed against',url);
