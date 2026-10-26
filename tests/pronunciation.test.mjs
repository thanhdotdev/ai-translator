import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/background/pronunciation.ts'],bundle:true,format:'esm',write:false});
const {parseWiktApi,parseWiktionaryHtml,dictionaryTerm,getPronunciation}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const fixture=name=>readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8');
const standard=JSON.parse(fixture('wiktapi-standard.json'));
const complete={entries:[{sounds:[{ipa:'/US/',tags:['General-American'],mp3_url:'https://upload.wikimedia.org/us.mp3',audio:'En-us-test.ogg'},{ipa:'/UK/',tags:['Received-Pronunciation'],mp3_url:'https://upload.wikimedia.org/uk.mp3',audio:'En-uk-test.ogg'}]}]};

test('WiktAPI merges separately labelled IPA and audio from real standard data',()=>{
  const result=parseWiktApi(standard,'standard');
  assert.equal(result.accents.US.ipa,'/ˈstændɚd/');assert.equal(result.accents.UK.ipa,'/ˈstændəd/');
  assert.match(result.accents.US.audio,/En-us-standard.ogg.mp3$/);
  assert.match(result.accents.US.sourceUrl,/commons.wikimedia.org/);
  assert.equal(result.genericIpa,undefined);
});
test('Wiktionary fallback extracts the same pronunciations and ignores IPA inside qualifiers',()=>{
  const result=parseWiktionaryHtml(fixture('wiktionary-standard.html'),'standard');
  assert.equal(result.accents.US.ipa,'/ˈstændɚd/');assert.equal(result.accents.UK.ipa,'/ˈstændəd/');
  assert.match(result.accents.US.audio,/En-us-standard.ogg.mp3$/);
});
test('greetings retains a clearly shared IPA and US recording without inventing UK audio',()=>{
  const result=parseWiktionaryHtml(fixture('wiktionary-greetings.html'),'greetings');
  assert.equal(result.genericIpa,'/ˈɡɹiːtɪŋz/');assert.match(result.accents.US.audio,/En-us-greetings.oga.mp3$/);
  assert.equal(result.accents.UK,undefined);
});
test('Wiktionary does not use IPA from other languages, definitions, or rhyme lists',()=>{
  const html='<h2 id="French">French</h2><h3 id="Pronunciation">Pronunciation</h3><span class="IPA">/wrong/</span><h2 id="English">English</h2><h3 id="Pronunciation_2">Pronunciation</h3><ul><li><span class="IPA">/right/</span></li><li><span class="IPA">-rhyme</span></li></ul><h3 id="Noun">Noun</h3><span class="IPA">/definition/</span><h2 id="German">German</h2><h3 id="Pronunciation_3">Pronunciation</h3><span class="IPA">/german/</span>';
  assert.equal(parseWiktionaryHtml(html,'test').genericIpa,'/right/');
});
test('malformed JSON, foreign-language entries and untrusted audio URLs are rejected',()=>{
  assert.equal(parseWiktApi({},'test').ok,false);
  const result=parseWiktApi({entries:[null,{lang_code:'fr',sounds:[{ipa:'/wrong/',tags:['US']}]},{sounds:[null,{ipa:12},{ipa:'/shared/',audio:'En-us-test.ogg',mp3_url:'https://evil.invalid/test.mp3'},{ipa:'/valid/',mp3_url:'javascript:alert(1)'}]}]},'test');
  assert.equal(result.accents.US.ipa,'/shared/');assert.equal(result.accents.US.audio,undefined);
  const html='<h2 id="English">English</h2><h3 id="Pronunciation">Pronunciation</h3><audio data-mwtitle="En-us-test.ogg"><source src="https://evil.invalid/a.mp3" type="audio/mpeg"></audio>';
  assert.deepEqual(parseWiktionaryHtml(html,'test').accents,{});
});
test('sentences and non-English selections never request a dictionary entry',async()=>{
  assert.equal(dictionaryTerm(' Standard '),'standard');assert.equal(dictionaryTerm('mother-in-law'),'mother-in-law');
  assert.equal(dictionaryTerm('return an error to the caller'),null);assert.equal(dictionaryTerm('dịch tiếng Việt'),null);
  assert.equal((await getPronunciation('Return an error.')).sentence,true);
});
test('complete WiktAPI data avoids a fallback request, deduplicates and caches',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.match(url,/api.wiktapi.dev/);assert.equal(options.credentials,'omit');return Response.json(complete);};
  try {const [a,b]=await Promise.all([getPronunciation('cached'),getPronunciation('Cached')]);assert.deepEqual(a,b);assert.equal(calls,1);await getPronunciation('cached');assert.equal(calls,1);} finally {globalThis.fetch=original;}
});
test('Wiktionary recovers when WiktAPI is unavailable',async()=>{
  const original=globalThis.fetch;const urls=[];
  globalThis.fetch=async url=>{urls.push(url);return url.includes('api.wiktapi.dev')?new Response('',{status:503}):Response.json({parse:{text:fixture('wiktionary-greetings.html')}});};
  try {const result=await getPronunciation('fallback');assert.equal(urls.length,2);assert.match(urls[1],/en.wiktionary.org/);assert.equal(result.genericIpa,'/ˈɡɹiːtɪŋz/');assert.equal(result.sourceName,'Wiktionary');} finally {globalThis.fetch=original;}
});
test('valid primary data survives a failed fallback',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>url.includes('api.wiktapi.dev')?Response.json(standard):new Response('',{status:503});
  try {const result=await getPronunciation('partial');assert.equal(result.ok,true);assert.equal(result.accents.UK.ipa,'/ˈstændəd/');} finally {globalThis.fetch=original;}
});
test('failed lookups can be retried rather than cached as missing pronunciations',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return calls<=2?new Response('',{status:503}):Response.json(complete);};
  try {assert.equal((await getPronunciation('retry')).ok,false);assert.equal((await getPronunciation('retry')).ok,true);assert.equal(calls,3);} finally {globalThis.fetch=original;}
});
test('Wiktionary fills in missing primary IPA while keeping a valid recording',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>url.includes('api.wiktapi.dev')?Response.json({entries:[{sounds:[{audio:'En-us-test.ogg',tags:['US'],mp3_url:'https://upload.wikimedia.org/primary.mp3'}]}]}):Response.json({parse:{text:fixture('wiktionary-standard.html')}});
  try {const result=await getPronunciation('enrichment');assert.equal(result.accents.US.audio,'https://upload.wikimedia.org/primary.mp3');assert.equal(result.accents.US.ipa,'/ˈstændɚd/');assert.equal(result.accents.UK.ipa,'/ˈstændəd/');} finally {globalThis.fetch=original;}
});

const voiceBundle=await build({entryPoints:['src/content/pronunciation-voices.ts'],bundle:true,format:'esm',write:false});
const {chooseAccentVoices,cambridgeLookupUrl}=await import('data:text/javascript;base64,'+Buffer.from(voiceBundle.outputFiles[0].text).toString('base64'));
test('device voices match the requested locale and prefer distinct natural voices',()=>{
  const voices=[{name:'Generic US',lang:'en_US',voiceURI:'us-1'},{name:'US Natural',lang:'en-US',voiceURI:'us-2'},{name:'UK Natural',lang:'en-GB',voiceURI:'uk-1'},{name:'Australian',lang:'en-AU',voiceURI:'au-1'}];
  const chosen=chooseAccentVoices(voices);
  assert.equal(chosen.US.voiceURI,'us-2'); assert.equal(chosen.UK.voiceURI,'uk-1');
});
test('missing regional voices never fall back to the other accent or a duplicate voice',()=>{
  const chosen=chooseAccentVoices([{name:'US',lang:'en-US',voiceURI:'same'},{name:'UK',lang:'en-GB',voiceURI:'same'},{name:'English',lang:'en',voiceURI:'unknown'}]);
  assert.equal(chosen.US.voiceURI,'same');assert.equal(chosen.UK,undefined);
  assert.equal(chooseAccentVoices([{name:'English',lang:'en',voiceURI:'unknown'}]).US,undefined);
});
test('Cambridge links are limited to dictionary terms, not whole sentences or code',()=>{
  assert.equal(cambridgeLookupUrl(' Greetings '),'https://dictionary.cambridge.org/dictionary/english/greetings');
  assert.equal(cambridgeLookupUrl('ice cream'),'https://dictionary.cambridge.org/dictionary/english/ice-cream');
  assert.equal(cambridgeLookupUrl('Change the function to return an error.'),null);
  assert.equal(cambridgeLookupUrl('javascript:alert(1)'),null);
});
