import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const dragBundle=await build({entryPoints:['src/content/panel-drag.ts'],bundle:true,format:'esm',write:false});
const {clampPanelPosition}=await import('data:text/javascript;base64,'+Buffer.from(dragBundle.outputFiles[0].text).toString('base64'));
const hostBundle=await build({entryPoints:['src/content/bilingual-host.ts'],bundle:true,format:'cjs',write:false});
function mockElement(tag){
  return {tagName:tag.toUpperCase(),dataset:{},children:[],attributes:{},styles:{},style:{setProperty(name,value){this[name]=value;}},setAttribute(name,value){this.attributes[name]=value;},appendChild(child){this.children.push(child);},attachShadow(){if(this.tagName!=='DIV')throw new Error('Unsupported ShadowRoot host');return {host:this};}};
}
const moduleObject={exports:{}};vm.runInNewContext(hostBundle.outputFiles[0].text,{module:moduleObject,exports:moduleObject.exports,document:{createElement:mockElement}});
const {createBilingualHost}=moduleObject.exports;

test('list translations attach a ShadowRoot to a DIV inside a list-item wrapper',()=>{
  const {host,shadow}=createBilingualHost(mockElement('li'));
  assert.equal(host.tagName,'LI');assert.equal(host.dataset.avtBilingual,'true');
  assert.equal(host.children.length,1);assert.equal(shadow.host.tagName,'DIV');
  assert.equal(host.attributes.role,'presentation');assert.equal(host.style['list-style'],'none');
});
test('ordinary paragraphs use a supported DIV host directly',()=>{
  const {host,shadow}=createBilingualHost(mockElement('p'));
  assert.equal(host.tagName,'DIV');assert.equal(shadow.host,host);assert.equal(host.children.length,0);
});
test('dragging is clamped to the viewport, including after a viewport shrink',()=>{
  const panel={width:420,height:460},viewport={width:1200,height:800};
  assert.deepEqual(clampPanelPosition({x:350,y:180},panel,viewport),{x:350,y:180});
  assert.deepEqual(clampPanelPosition({x:-100,y:-20},panel,viewport),{x:12,y:12});
  assert.deepEqual(clampPanelPosition({x:2000,y:1000},panel,viewport),{x:768,y:328});
  assert.deepEqual(clampPanelPosition({x:500,y:500},panel,{width:360,height:320}),{x:12,y:12});
});
