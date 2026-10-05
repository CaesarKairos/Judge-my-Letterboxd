import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filmsFromExport} from '../js/export-preview.js';

const u16=value=>new Uint8Array([value&255,value>>>8&255]),u32=value=>new Uint8Array([value&255,value>>>8&255,value>>>16&255,value>>>24&255]),join=parts=>{const out=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
const storedZip=files=>{const encoder=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const [name,text] of Object.entries(files)){const n=encoder.encode(name),data=encoder.encode(text),local=join([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(0),u32(data.length),u32(data.length),u16(n.length),u16(0),n,data]);locals.push(local);centrals.push(join([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(0),u32(data.length),u32(data.length),u16(n.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),n]));offset+=local.length;}const central=join(centrals);return join([...locals,central,u32(0x06054b50),u16(0),u16(0),u16(centrals.length),u16(centrals.length),u32(central.length),u32(offset),u16(0)]);};

test('loading preview reads unique watched films locally from the selected ZIP',async()=>{
 const zip=storedZip({'watched.csv':'Date,Name,Year\n2026-01-01,Fixture Film,2001\n2026-01-02,Second Fixture,2002\n','ratings.csv':'Date,Name,Year,Rating\n2026-01-03,Fixture Film,2001,5\n2026-01-04,Third Fixture,2003,4.5\n'}),file=new Blob([zip]);
 const films=await filmsFromExport(file);assert.deepEqual(new Set(films.map(film=>film.title)),new Set(['Fixture Film','Second Fixture','Third Fixture']));assert.equal(films.length,3);
});

test('loading preview keeps the complete 106-film deduplicated pool',async()=>{
 const rows=Array.from({length:106},(_,index)=>`2026-01-01,Film ${index+1},${1900+index}`).join('\n'),duplicates='Date,Name,Year,Rating\n2026-01-01,Film 1,1900,5\n2026-01-01,Film 106,2005,4\n',file=new Blob([storedZip({'watched.csv':`Date,Name,Year\n${rows}\n`,'ratings.csv':duplicates,'diary.csv':'Date,Name,Year\n2026-01-01,Film 50,1949\n'})]);
 const films=await filmsFromExport(file);assert.equal(films.length,106);assert.equal(new Set(films.map(film=>`${film.title}|${film.year}`)).size,106);
});
