import test from 'node:test';import assert from 'node:assert/strict';import {mergeProfileRows,summarizeProfiles} from '../worker/profile-usage.js';
const now=Date.parse('2026-11-27T00:00Z'),scope='account-1';
const row=(profile,writer,n)=>({scope,profile,writer,day:'2026-11-27',counts:{speechCharacters:n}});
test('retry and independent writers and profiles',()=>{let rows=mergeProfileRows([], [row('a','w',5),row('a','w2',3),row('b','w',4)],scope,now);rows=mergeProfileRows(rows,[row('a','w',7),row('a','w',2),row('a','w2',3)],scope,now);const s=summarizeProfiles(rows);assert.equal(s.a['2026-11-27'].speechCharacters,10);assert.equal(s.b['2026-11-27'].speechCharacters,4);});
test('reject foreign scope, invalid counters and future day',()=>{for(const r of [{...row('a','w',1),scope:'different'},row('a','w',-1),{...row('a','w',1),day:'2026-11-28'}])assert.throws(()=>mergeProfileRows([], [r],scope,now));});
