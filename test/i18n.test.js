import test from 'node:test';
import assert from 'node:assert/strict';
import { DICT, t, normalizeLocale } from '../src/i18n.js';
import { secretRequestPayload, secretModal, authMethodPayload, authQrPayload, humanCheckPayload } from '../src/computer/ui.js';
import { makeDecider } from '../src/computer/vision.js';
import { runComputerTask } from '../src/computer/loop.js';
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = '1';
process.env.HARKLET_DB = ':memory:';
const { store } = await import('../src/db.js');
const { userLang, responseLanguage, noteAutoLang, noteLocale, languageTag } = await import('../src/user-lang.js');
const { commands } = await import('../src/commands.js');

test('catalogs have the same keys and placeholders; substitution never interprets user text', () => {
  const placeholders = value => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map(m => m[1]).sort();
  for (const lang of ['ja', 'zh']) {
    assert.deepEqual(Object.keys(DICT[lang]).sort(), Object.keys(DICT.en).sort());
    for (const key of Object.keys(DICT.en)) assert.deepEqual(placeholders(DICT[lang][key]), placeholders(DICT.en[key]), key);
  }
  assert.equal(t('ko', 'cu.done', { summary: '{reason}' }), '✅ Done: {reason}');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('zh-TW'), 'zh');
});

test('explicit language survives locale changes; auto can switch and settings stay isolated', () => {
  noteLocale('u1', 'ja');
  noteAutoLang('u1', '東京');
  assert.equal(userLang('u1'), 'ja');
  noteAutoLang('u1', 'please open gmail');
  assert.equal(userLang('u1'), 'en');
  noteLocale('u2', 'zh-CN');
  assert.equal(userLang('u2'), 'zh');
  store.setModel('u1', 'model-a');
  store.setLang('u1', 'ko');
  noteLocale('u1', 'ja');
  noteAutoLang('u1', 'こんにちは');
  assert.equal(store.getSettings('u1').lang, 'ko');
  assert.equal(userLang('u1'), 'en');
  assert.equal(store.getSettings('u1').model, 'model-a');
  store.setLang('u1', null);
  noteLocale('u1', 'ja');
  assert.equal(userLang('u1'), 'ja');
  assert.equal(languageTag('es-mx'), 'es-MX');
  assert.equal(languageTag('invalid language'), null);
  store.setLang('u1', 'es');
  assert.equal(userLang('u1'), 'en');
  assert.equal(responseLanguage('u1'), 'es');
});

test('localized Discord handoffs serialize and modal labels fit platform limits', () => {
  for (const lang of ['en','ja','zh']) {
    const fields = [{ name: 'email', label: 'Email' }];
    for (const payload of [secretRequestPayload('1','message',fields,'https://example.com',lang), authMethodPayload('1','message',[{id:'email',label:'Email'},{id:'totp',label:'Authenticator'}],lang), authQrPayload('1',Buffer.from('png'),'message',lang), humanCheckPayload('1','message',true,lang)]) {
      assert.ok(payload.embeds[0].toJSON().title);
      payload.components.forEach(row => row.toJSON());
    }
    assert.equal(secretModal('1',fields,lang).toJSON().title, t(lang,'cu.secretModalTitle'));
    for (const key of ['modal.modelLabel','modal.searchLabel','modal.projLabel','modal.googleLabel','modal.regionLabel']) assert.ok(t(lang,key).length<=45,key);
  }
  const payload = commands.map(c=>c.toJSON());
  assert.ok(payload.some(c=>c.name==='language'));
  assert.equal(new Set(payload.map(c=>c.name)).size,payload.length);
  for(const cmd of payload.filter(c=>c.name!=='language')) assert.ok(cmd.description_localizations.ja);
});

test('vision language reaches every provider and user progress is localized', async () => {
  for (const provider of ['openai','anthropic','google']) {
    const decide=makeDecider({ provider,baseUrl:'https://example.test',apiKey:'test',model:'test',lang:'ko',fetchImpl:async (_url,opts)=>{
      const body=JSON.parse(opts.body);
      const system=provider==='openai'?body.messages[0].content:provider==='anthropic'?body.system:body.systemInstruction.parts[0].text;
      assert.ok(system.includes('must use ko.'));
      return {ok:true,json:async()=>provider==='anthropic'?{content:[{type:'text',text:'{"action":"done","summary":"완료"}'}]}:provider==='google'?{candidates:[{content:{parts:[{text:'{"action":"done","summary":"완료"}'}]}}]}:{choices:[{message:{content:'{"action":"done","summary":"완료"}'}}]}};
    }});
    const action=await decide({task:'웹 페이지를 열어줘',history:[],width:800,height:600,secretNames:[]});
    assert.equal(action.summary,'완료');
  }
  const progress=[];
  let step = 0;
  const result=await runComputerTask({userId:'test',task:'open page',sessionId:'test',lang:'en',browser:{screenshot:async()=>({width:800,height:600,png_base64:'AA'}),elements:async()=>null,act:async()=>{}},vault:{listSecretNames:()=>[]},decide:async()=>({action:'click',x:++step,y:10}),progress:async m=>progress.push(m),sleep:async()=>{},maxSteps:5});
  assert.equal(result.status,'max_steps');
  assert.deepEqual(progress,['⏳ 5 steps so far']);
});
