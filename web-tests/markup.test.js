import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plainText,parseMarkup} from '../js/utils.js';
import {readWait,timing} from '../js/animations.js';
import {structuredReview} from '../functions/_lib/letterboxd.js';

// The exact shape that reached production: a review ending in real blockquote markup.
const review='Esse filme é brutal, ele não romantiza nada.\r\n\r\n​Dito isso, de pau duro e triste.<blockquote>"Jack, I swear..." — Ennis Del Mar</blockquote>';

test('letterboxd blockquote markup becomes a typed part, never literal text',()=>{
 const parts=parseMarkup(review);
 assert.deepEqual(parts.map(part=>part.type),['text','blockquote']);
 assert.equal(parts[1].text,'"Jack, I swear..." — Ennis Del Mar');
 assert.ok(parts.every(part=>!part.text.includes('<')&&!part.text.includes('>')));
 assert.equal(plainText(review).includes('<blockquote>'),false);
 assert.match(plainText(review),/Dito isso, de pau duro e triste\./);
 assert.match(plainText(review),/"Jack, I swear\.\.\." — Ennis Del Mar$/);
});

test('aliases, nesting, entities and hostile tags stay safe',()=>{
 assert.deepEqual(parseMarkup('<b>bold</b> and <i>italic</i>').map(part=>part.type),['strong','text','em']);
 assert.equal(parseMarkup('<img src=x onerror=alert(1)>').length,0);
 assert.deepEqual(parseMarkup('<p>one</p><p>two</p>').map(part=>part.text),['one','two']);
 assert.equal(plainText('Tom &amp; Jerry &#65;'),'Tom & Jerry A');
 assert.equal(plainText('1 <3> 2'),'1 <3> 2');
 assert.deepEqual(parseMarkup('tem <b>um</b> gosto').map(part=>part.text),['tem ','um',' gosto']);
});

test('worker evidence text never carries markup',()=>{
 const {text,segments}=structuredReview(review);
 assert.equal(text.includes('<'),false);
 assert.equal(text.includes('blockquote'),false);
 assert.deepEqual(segments.map(segment=>segment.type),['text','blockquote']);
 assert.equal(segments[1].text,'"Jack, I swear..." — Ennis Del Mar');
});

test('evidence waits grow with the text and stay capped',()=>{
 assert.equal(readWait('abcde'),timing.evidence+5*timing.read);
 assert.ok(readWait('x'.repeat(400),timing.review)>readWait('x',timing.review));
 assert.equal(readWait('x'.repeat(10000)),timing.readMax);
});
