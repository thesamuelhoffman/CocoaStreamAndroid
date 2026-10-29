import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync('app/src/main/assets/app/app.js','utf8');
const start=source.indexOf('function renderHome() {');
const end=source.indexOf('async function loadHome(',start);
const item={id:'tt0000001',type:'movie',name:'Available in catalog'};
let html='';let checks=0;
const page={set innerHTML(value){html=value;}};
const context={state:{rows:[{name:'Popular',items:[item]}],data:{history:[]},mediaIndex:new Map()},
 window:{scrollY:0,scrollTo(){}},$:s=>s==='#page'?page:null,
 canonicalKey:x=>x.id,isSeriesLike:()=>false,registerItems(){},continueWatching:()=>[],latestPerMedia:()=>[],
 recommendationScore:()=>1,uniqueByKey:()=>true,heroHtml:()=>'<section>Spotlight</section>',rowHtml:(n,items)=>items.map(x=>x.name).join(''),
 wireMediaClicks(){},wireImageFallbacks(){},unplayable:new Set(['tt0000001']),confirmedPlayable:new Set(),screenHome(){checks++;}};
vm.runInNewContext(source.slice(start,end)+'\nrenderHome()',context);
assert.ok(html.includes('Spotlight'),'Spotlight cannot wait for a source lookup');
assert.ok(html.includes(item.name),'Keep catalog items even if no sources were previously found');
assert.equal(checks,0,'Home must not query stream add-ons');
console.log('Startup: immediate Spotlight, full catalog, no source screening PASS');
