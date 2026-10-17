import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserArtKey, isBrowserPlaceholder, matchingUrl } from '../bridge/nowplaying/browser-art.js';
import { normalize } from '../bridge/nowplaying/mediaremote.js';

test('videos sharing artwork do not share upgraded thumbnails', () => {
  const first = { bundleId: 'company.thebrowser.Browser', title: 'First video', contentId: 'first', artwork: { key: 'shared-image' } };
  assert.notEqual(browserArtKey(first), browserArtKey({ ...first, title: 'Second video', contentId: 'second' }));
  assert.notEqual(browserArtKey(first), browserArtKey({ ...first, contentId: 'another-video-with-the-same-title' }));
  assert.equal(browserArtKey(first), browserArtKey({ ...first, elapsed: 42, playing: false }));
  assert.equal(browserArtKey({ ...first, artwork: null }), null);
});

test('only an unambiguous complete tab title can supply a thumbnail', () => {
  const exact = 'https://www.youtube.com/watch?v=abcdefghijk';
  const longer = 'https://www.youtube.com/watch?v=lmnopqrstuv';
  assert.equal(matchingUrl(`Example - YouTube\t${exact}\nExample extended - YouTube\t${longer}`, 'Example'), exact);
  assert.equal(matchingUrl(`Example extended - YouTube\t${longer}`, 'Example'), null);
  assert.equal(matchingUrl(`Example - YouTube\t${exact}\nExample - YouTube\t${longer}`, 'Example'), null);
  assert.equal(matchingUrl(`Example - YouTube\t${exact}\nExample - YouTube\t${exact}`, 'Example'), exact);
  assert.equal(matchingUrl('Example\tfile:///private/example', 'Example'), null);
});

test('the known Chromium icon is a placeholder only for browsers', () => {
  assert.equal(isBrowserPlaceholder('company.thebrowser.Browser', '8e5b3282f2d4863b'), true);
  assert.equal(isBrowserPlaceholder('com.apple.Music', '8e5b3282f2d4863b'), false);
  assert.equal(isBrowserPlaceholder('company.thebrowser.Browser', 'real-thumbnail'), false);
});

test('missing thumbnails stay absent while media identity remains available', () => {
  const snapshot = normalize({ title: 'Video without artwork', bundleIdentifier: 'company.thebrowser.Browser', contentItemIdentifier: 'video-1' });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.artwork, null);
  assert.equal(snapshot.contentId, 'video-1');
});
