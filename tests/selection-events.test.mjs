import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({entryPoints:['src/content/selection-events.ts'],bundle:true,format:'esm',write:false});
const {watchSelectionEvents} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function setup() {
  const targets={window:new EventTarget(),document:new EventTarget()};
  let selections=0,outside=0;
  const stop=watchSelectionEvents({isInside:event=>Boolean(event.inside),onSelect:()=>selections++,onOutsidePointer:()=>outside++},targets);
  const emit=(target,type,properties={})=> {const event=new Event(type);Object.assign(event,properties);target.dispatchEvent(event);};
  return {targets,emit,stop,counts:()=>({selections,outside})};
}
test('selection tracking listens in capture phase, before page bubbling handlers',()=>{
  const registered=[];const target={addEventListener:(name,_fn,capture)=>registered.push([name,capture]),removeEventListener:()=>{}};
  watchSelectionEvents({isInside:()=>false,onSelect:()=>{},onOutsidePointer:()=>{}},{window:target,document:target});
  assert.ok(registered.every(([,capture])=>capture===true));
  assert.ok(registered.some(([name])=>name==='mouseup'));assert.ok(registered.some(([name])=>name==='selectionchange'));
});
test('waits until drag ends, supports mouse fallback, keyboard selection and cleanup',()=>{
  const app=setup();app.emit(app.targets.window,'pointerdown',{button:0});app.emit(app.targets.document,'selectionchange');assert.equal(app.counts().selections,0);
  app.emit(app.targets.window,'pointerup',{button:0});assert.equal(app.counts().selections,1);
  app.emit(app.targets.document,'selectionchange');app.emit(app.targets.window,'mouseup',{button:0});assert.equal(app.counts().selections,3);
  app.emit(app.targets.window,'keyup',{key:'a',metaKey:true});assert.equal(app.counts().selections,4);
  app.emit(app.targets.window,'pointerup',{button:0,inside:true});assert.equal(app.counts().selections,4);
  app.stop();app.emit(app.targets.document,'selectionchange');assert.equal(app.counts().selections,4);
});
