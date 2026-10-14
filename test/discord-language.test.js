import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DISCORD_TOKEN='test-token';
process.env.DISCORD_CLIENT_ID='1';
process.env.HARKLET_DB=':memory:';
process.env.LLM_API_KEY='';
process.env.OPENAI_API_KEY='';
process.env.OPENROUTER_API_KEY='';
const { handlers, modelPanel, execAction } = await import('../src/index.js');
const { store }=await import('../src/db.js');
const { noteLocale }=await import('../src/user-lang.js');

test('model menu and real interaction modals fit Discord limits in all UI languages', async()=>{
 for(const lang of ['en','ja','zh']) {
  store.setLang('u',lang);
  const panel=await modelPanel('u');
  assert.ok(panel.embeds[0].toJSON().title);
  panel.components.forEach(row=>row.toJSON());
  const outputs=[];
  const i={user:{id:'u'},locale:lang,options:{getString:()=>lang},reply:async payload=>outputs.push(payload)};
  await handlers.language(i);
  assert.ok(outputs[0].content.includes(lang==='ja'?'日本語':lang==='zh'?'中文':'English'));
 }
});

test('language switches preserve memories/models; actual action results follow selected language',async()=>{
 store.setModel('u','model');
 const outputs=[];
 const i={user:{id:'u'},locale:'ja',options:{getString:()=> 'ko'},reply:async p=>outputs.push(p)};
 await handlers.language(i);
 assert.equal(store.getSettings('u').lang,'ko');
 assert.equal(store.getSettings('u').model,'model');
 const reply=await execAction({userId:'u',action:{kind:'memory',arg:'example'}});
 assert.ok(reply.startsWith('🧠 Remembered:'));
 assert.equal(store.listMemories('u')[0].content,'example');
 i.options.getString=()=> 'auto';
 noteLocale('u','ja');
 await handlers.language(i);
 assert.equal(store.getSettings('u').lang,null);
 const ja=await execAction({userId:'u',action:{kind:'memory',arg:'test'}});
 assert.ok(ja.startsWith('🧠 記憶しました:'));
});
