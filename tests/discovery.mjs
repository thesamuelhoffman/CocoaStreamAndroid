import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { AddonClient }=await import(pathToFileURL(process.cwd()+'/app/src/main/assets/app/addons-client.js'));
const data={addons:[{key:'cinemeta',url:'https://example.org/manifest.json',manifest:{id:'cinemeta',catalogs:[]}}],preferences:{}};
const client=new AddonClient(()=>data,async()=>{});
client.ensureDiscoveryManifests=async()=>data.addons;
client.ensureManifests=async()=>data.addons;
client.catalog=async(addon,type,id,extra)=>{
 if(extra?.genre==='Horror')return new Promise(()=>{});
 return [{id:type+'-'+id,type,name:'A title'}];
};
let first;
const ready=new Promise(resolve=>first=resolve);
client.homeRows(rows=>{if(rows.length)first(rows);});
const result=await Promise.race([ready,new Promise(resolve=>setTimeout(()=>resolve(null),100))]);
assert.ok(result?.length,'One slow genre must not delay the first visible catalog');
console.log('Progressive catalog: first rows render while slow genres are pending PASS');
