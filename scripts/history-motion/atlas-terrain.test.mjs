import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {copernicusPages, copernicusRaster, shadeAtlasRaster} from './atlas-terrain.mjs';

const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');

function tinyCog() {
  const width = 16, raw = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) raw.writeFloatLE(1000.25 + x * 2 + y * 4, (y * width + x) * 4);
  const compressed = deflateSync(raw), bytes = Buffer.alloc(32768), pixelOffset = 1024;
  bytes.write('II');bytes.writeUInt16LE(42, 2);bytes.writeUInt32LE(8, 4);
  const tags = [[256,4,[16]],[257,4,[16]],[258,3,[32]],[259,3,[8]],[262,3,[1]],[277,3,[1]],[284,3,[1]],[317,3,[1]],
    [322,4,[16]],[323,4,[16]],[324,4,[pixelOffset]],[325,4,[compressed.length]],[339,3,[3]],
    [33550,12,[1/16,1/16,0]],[33922,12,[0,0,0,113,37,0]]];
  bytes.writeUInt16LE(tags.length,8);let indirect=512;
  for(let i=0;i<tags.length;i++) {
    const [tag,type,values]=tags[i],entry=10+i*12,size=type===3?2:type===4?4:8;
    bytes.writeUInt16LE(tag,entry);bytes.writeUInt16LE(type,entry+2);bytes.writeUInt32LE(values.length,entry+4);
    let target=entry+8;
    if(values.length*size>4){target=indirect;bytes.writeUInt32LE(target,entry+8);indirect+=values.length*size;}
    for(let j=0;j<values.length;j++)if(type===3)bytes.writeUInt16LE(values[j],target+j*size);else if(type===4)bytes.writeUInt32LE(values[j],target+j*size);else bytes.writeDoubleLE(values[j],target+j*size);
  }
  compressed.copy(bytes,pixelOffset);return bytes;
}

test('COG range decoding preserves metre-valued floating elevations and offline reuse',async t=>{
  const cacheDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-cog-'));
  t.after(()=>fs.rmSync(cacheDirectory,{recursive:true,force:true}));
  const bytes=tinyCog(),calls=[];
  const ctx={cacheDirectory,network:true,deadline:Date.now()+5000,requestTimeoutMs:1000,fetchImpl:async(url,options)=>{
    calls.push({url,range:options.headers.Range});
    const end=Number(options.headers.Range.split('-')[1]);
    return new Response(bytes.subarray(0,end+1),{status:206,headers:{'content-range':`bytes 0-${end}/${bytes.length}`}});
  }};
  const bounds={minLon:113,maxLon:114,minLat:36,maxLat:37};
  const result=await copernicusRaster(bounds,16,16,ctx);
  assert.equal(result.raster[0],1000.25);
  assert.equal(result.raster[8*16+8],1048.25);
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.range.startsWith('bytes=0-')));
  const cached=await copernicusRaster(bounds,16,16,{...ctx,network:false,fetchImpl:()=>{throw Error('network forbidden');}});
  assert.deepEqual(cached.raster,result.raster);
  assert.equal(result.source.tiles[0].overview,0);
});

test('COG directories reject corrupt metadata and non-range responses',async t=>{
  assert.throws(()=>copernicusPages(Buffer.from('not-a-tiff')),/TIFF/);
  const corrupted=tinyCog();corrupted.writeUInt32LE(50000,4);
  assert.throws(()=>copernicusPages(corrupted),/越界/);
  const cacheDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-cog-reject-'));
  t.after(()=>fs.rmSync(cacheDirectory,{recursive:true,force:true}));
  await assert.rejects(copernicusRaster({minLon:113,maxLon:114,minLat:36,maxLat:37},16,16,
    {cacheDirectory,network:true,deadline:Date.now()+5000,requestTimeoutMs:1000,fetchImpl:async()=>new Response(tinyCog())}),/范围请求/);
});

test('uniform elevations remain uniform, while measured relief creates visible shading',async()=>{
  const width=64,height=36,bounds={minLon:113,maxLon:113.1,minLat:36,maxLat:36.05};
  const flat=new Float32Array(width*height).fill(350);
  const flatPng=await shadeAtlasRaster(flat,bounds,width,height),flatStats=await sharp(flatPng).stats();
  assert.ok(flatStats.channels.every(channel=>channel.stdev<.00001),'flat terrain must not acquire decorative fake mountains');
  const hills=Float32Array.from(flat,(_,i)=>350+300*Math.exp(-((i%width-32)**2+(Math.floor(i/width)-18)**2)/100));
  const hillPng=await shadeAtlasRaster(hills,bounds,width,height),hillStats=await sharp(hillPng).stats();
  assert.ok(hillStats.channels.some(channel=>channel.stdev>10));
  await assert.rejects(shadeAtlasRaster(new Float32Array(3),bounds,width,height),/尺寸/);
});
