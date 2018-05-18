/* eslint-disable no-restricted-globals */
/* global Ipfs */

import fileType from 'file-type';
import readableStreamNodeToWeb from 'readable-stream-node-to-web';
import mimeTypes from 'mime-types';
import nodeStream from 'stream';

import { joinURLParts, removeTrailingSlash } from './pathUtil';
import { resolveDirectory, resolveMultihash } from './resolver';

// inject Ipfs to global
importScripts('https://cdn.jsdelivr.net/npm/ipfs/dist/index.js');

const ipfsRoute = `ipfs`;

let ipfsNode = null;

/** create an in memory node (side effect) */
function initIPFS() {
  const repoPath = `ipfs-${Math.random()}`;
  ipfsNode = new Ipfs({
    repo: repoPath,
    config: {
      Addresses: {
        API: '/ip4/127.0.0.1/tcp/0',
        Swarm: ['/ip4/0.0.0.0/tcp/0'],
        Gateway: '/ip4/0.0.0.0/tcp/0',
      },
    },
  });
}

/** helper function to always get an ipfs node that's ready to use
 modified from https://github.com/linonetwo/pants-control/blob/0e6cb6d8c319ede051a9aa5279f3a0192e578b9f/src/ipfs/IPFSNode.js#L27 */
function getReadyNode() {
  if (ipfsNode === null) {
    initIPFS();
  }
  return new Promise(resolve => {
    if (ipfsNode.isOnline()) {
      resolve(ipfsNode);
    } else {
      ipfsNode.on('ready', () => {
        if (ipfsNode.isOnline()) {
          resolve(ipfsNode);
        }
      });
    }
  });
}

// Used in new Response()
const headerOK = { status: 200, statusText: 'OK', headers: {} };
const headerError = { status: 500, statusText: 'Service Worker Error', headers: {} };
const headerNotFound = { status: 404, statusText: 'Not Found', headers: {} };
const headerBadRequest = { status: 400, statusText: 'BadRequest', headers: {} };

function handleGatewayResolverError(ipfs, path, err) {
  if (err) {
    console.info(`fileName: ${err.fileName} , handleGatewayResolverError() Handling ${err.toString()}`);

    const errorToString = err.toString();

    switch (true) {
      case errorToString === 'Error: This dag node is a directory':
        return resolveDirectory(ipfs, path, err.fileName)
          .then(content => {
            // now content is rendered DOM string
            if (typeof content === 'string') {
              // no index file found, send rendered directory list DOM string
              return new Response(content, {
                ...headerOK,
                headers: { 'Content-Type': mimeTypes.contentType('.html') },
              });
            }
            // found index file
            // redirect to URL/<found-index-file>
            return Response.redirect(joinURLParts(ipfsRoute, path, content[0].name));
          })
          .catch(error => {
            console.error(error);
            return new Response(error.toString(), headerError);
          });
      case errorToString.startsWith('Error: no link named'):
        return new Response(errorToString, headerNotFound);
      case errorToString.startsWith('Error: multihash length inconsistent'):
      case errorToString.startsWith('Error: Non-base58 character'):
        // not sure if it needs JSON.stringify
        return new Response(errorToString, headerBadRequest);
      default:
        console.error(err);
        return new Response(errorToString, headerError);
    }
  }
}

async function getFile(path) {
  if (path.endsWith('/')) {
    // remove trailing slash for files
    return Response.redirect(`${ipfsRoute}/${removeTrailingSlash(path)}`);
  }

  const ipfs = await getReadyNode();
  return resolveMultihash(ipfs, path)
    .then(({ multihash }) => {
      const ipfsStream = ipfs.files.catReadableStream(multihash);
      const responseStream = new nodeStream.PassThrough();
      ipfsStream.pipe(responseStream);
      console.log(`Getting stream ${ipfsStream}`);

      return new Promise(resolve => {
        ipfsStream.once('error', error => {
          if (error) {
            console.error(error);
            resolve(new Response(error.toString(), headerError));
          }
        });

        // TODO: maybe useless? I guess it's for earlier version of ipfs, or for pullStream
        if (!ipfsStream._read) {
          ipfsStream._read = () => {};
          ipfsStream._readableState = {};
        }

        // return Response only after first chunk being checked
        let filetypeChecked = false;
        ipfsStream.on('data', chunk => {
          // check mime on first chunk
          if (filetypeChecked) return;
          filetypeChecked = true;
          // return Response with mime type
          const fileSignature = fileType(chunk);
          const mimeType = mimeTypes.lookup(fileSignature ? fileSignature.ext : null);
          if (mimeType) {
            console.log(`returning stream with ${mimeType}`);
            resolve(
              new Response(readableStreamNodeToWeb(responseStream), {
                ...headerOK,
                headers: { 'Content-Type': mimeTypes.contentType(mimeType) },
              }),
            );
          } else {
            console.log('return stream without mimeType');
            resolve(new Response(readableStreamNodeToWeb(responseStream), headerOK));
          }
        });
      });
    })
    .catch(err => handleGatewayResolverError(ipfs, path, err));
}

self.addEventListener('install', event => {
  // kick previous sw after install
  console.log('Service worker is installing.');
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  if (event.request.url.startsWith(`${self.location.origin}/${ipfsRoute}`)) {
    // 1. we will goto /${ipfsRoute}/multihash so this will be a multihash
    // 2. if returned file of that multihash is a HTML, it will request for other content
    // so this will be content name. We may had cached this file in 1, so subsequent request will hit the cache.
    const multihashOrContentName = event.request.url.split(`/${ipfsRoute}/`)[1];
    console.log(`Service worker getting ${multihashOrContentName}`);
    event.respondWith(getFile(multihashOrContentName));
  }
});
