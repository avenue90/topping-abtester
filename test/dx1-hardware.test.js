import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFrame, buildReadRequest, frameCrc, decodeNextOutput, summarizeReads } from '../src/dx1-protocol.js';
import { PresetCollector, matchedPreamp, decodePreset } from '../src/dx1-presets.js';
import { Dx1Transport } from '../src/dx1-transport.js';
import { Dx1Controller, buildControlWrite } from '../src/dx1-controller.js';
const capture = JSON.parse(readFileSync(new URL('fixtures/dx1-next-0307.json', import.meta.url)));

function words() {
  const result = Array(78).fill(0); result[0] = 0x325145; // EQ2, little endian
  result[4] = result[6] = 1; result[5] = result[7] = 0x9e390c; // -10.2 dB
  return result;
}
function encode(frame) {
  const bytes = Uint8Array.of(0x22, 0x33, frame.type ?? 0x10, frame.count ?? 1, frame.index ?? 1,
    frame.command >> 8, frame.command & 255, 0, 0, 0, 0, 0, 0, 0x66, 0x77, 0);
  const view = new DataView(bytes.buffer); view.setUint32(7, frame.value);
  view.setUint16(11, frameCrc(bytes.subarray(2, 11)));
  return bytes;
}
class Device extends EventTarget {
  productName = 'DX1 II'; vendorId = 0x152a; productId = 0x8750; opened = false;
  collections = [{ usagePage: 1, usage: 0, inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 16 }] }],
    outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 16 }] }] }];
  sent = []; values = new Map([[0x1202,775],[0x8107,192],[0x7100,1],[0x7500,0],[0x1204,7],[0x1206,1]]);
  output = [3842,130,910,670,860,990,0,0,0,0,0,0]; presetWords = words();
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  emit(frame) {
    const event = new Event('inputreport'); event.reportId = 0;
    event.data = new DataView(encode(frame).buffer); this.dispatchEvent(event);
  }
  async sendReport(id, bytes) {
    assert.equal(id, 0); const f = parseFrame(bytes); this.sent.push(f);
    if (this.hook?.(f) === false) return;
    if (f.type === 0x20) {
      if (this.failCommand === f.command) throw new Error('Injected USB write failure');
      if (f.command === 0x810a) this.output[f.index-1] = f.value;
      if (f.command === 0x7500) this.values.set(f.command, f.value);
      if (f.command === 0x110e) this.values.set(0x1204,4);
      if (f.command === 0x1206) { this.values.set(f.command,f.value); this.values.set(0x1204,7); }
      this.emit(f); return;
    }
    if (f.command === 0x1106) {
      this.emit({command:f.command,count:2,index:0,value:3}); this.emit({command:f.command,count:2,index:1,value:0});
      for(let j=0;j<3;j++) this.presetWords.forEach((value,index)=>this.emit({command:f.command,count:78,index,value}));
    } else if(f.command === 0x810a) this.output.forEach((value,index)=>this.emit({command:f.command,count:12,index:index+1,value}));
    else if(f.command === 0x111c) [0xff00,0,0].forEach((value,index)=>this.emit({command:f.command,count:3,index,value}));
    else this.emit({...f,value:this.values.get(f.command)});
  }
}
async function connect() {
  const device = new Device(), transport = new Dx1Transport(device,{timeoutMs:50}), controller = new Dx1Controller(transport);
  await controller.connect(); return {device,transport,controller};
}
const condition = (controller, peq = false, gain = 'low') => ({peq,gain,preampDb:controller.preampDb,trimDb:0});

test('real user capture passes checksum validation and decodes headphone state', () => {
  for(const record of capture.records.filter(r=>r.direction==='in'&&r.frame)) {
    const bytes=Uint8Array.from(record.hex.split(' '),x=>parseInt(x,16));
    assert.deepEqual(parseFrame(bytes,0,{requireCrc:true}),record.frame);
    bytes[7]^=1; assert.equal(parseFrame(bytes,0,{requireCrc:true}),null);
  }
  const output=decodeNextOutput(capture.reads.nextOutput.frames);
  assert.equal(output.volumeDb,-8); assert.equal(output.outputMask,2); assert.equal(output.peqRoute,'both');
  assert.equal(output.fixed0Db,false); assert.equal(output.analogMuted,false);
  assert.equal(summarizeReads(capture.reads).headphoneVolumeDb,-8);
});

test('strict preset collector does not invent values for missing packets', () => {
  const c=new PresetCollector(); c.ingest({command:0x1106,count:2,index:0,value:1}); c.ingest({command:0x1106,count:2,index:1,value:0});
  assert.throws(()=>c.ingest({command:0x1106,count:78,index:1,value:0}),/reordered/);
  const p=decodePreset(words()); assert.equal(p.name,'EQ2'); assert.equal(matchedPreamp(p),-10.2);
  p.right.gainDb=-3; assert.throws(()=>matchedPreamp(p),/differ/);
});

test('write allowlist targets Next HP field and never modifies DSP or routing', () => {
  assert.deepEqual(parseFrame(buildControlWrite('volume',-40)),{type:32,count:12,index:3,command:0x810a,value:590});
  assert.equal(parseFrame(buildControlWrite('peq',false)).value,0xffffffff);
  assert.equal(parseFrame(buildControlWrite('peq',1)).command,0x1206);
  assert.throws(()=>buildControlWrite('volume',-40.5)); assert.throws(()=>buildControlWrite('reset',1));
});

test('connect reads stored pre-gain without writing audio settings',async()=>{
  const {device,controller}=await connect(); assert.equal(controller.preampDb,-10.2);
  assert.equal(controller.state.volumeDb,-8); assert.ok(device.sent.every(f=>f.type===0x10)); await controller.close();
});

test('real adapter verifies attenuation, PEQ bypass and final level without touching gain',async()=>{
  const {device,controller}=await connect();
  const result=await controller.apply('a',condition(controller,false,'low'),-32,'dx1');
  const writes=device.sent.filter(f=>f.type===32);
  assert.equal(writes.some(f=>f.command===0x7500),false);
  assert.equal(writes.some(f=>f.command===0x110e),true);
  assert.equal(result.volumeDb,-32); assert.equal(controller.state.peq,false);
  await controller.apply('b',condition(controller,true,'low'),-8,'dx1');
  assert.equal(controller.state.peq,true); assert.equal(controller.state.volumeDb,-8);
  device.emit({command:0x1204,value:7});
  device.emit({command:0x810a,count:12,index:3,value:910});
  assert.equal(controller.applied.side,'b');
  await controller.close();
});

test('live gain changes are rejected before any write',async()=>{
  const {device,controller}=await connect();const count=device.sent.length;
  await assert.rejects(controller.apply('a',condition(controller,false,'high'),-32,'dx1'),/unavailable/);
  assert.equal(device.sent.length,count);assert.equal(controller.applied,null);await controller.close();
});

test('a PEQ echo without matching state cannot raise final volume',async()=>{
  const {device,controller}=await connect();
  device.hook=f=>{if(f.type===32&&f.command===0x110e){device.emit(f);return false;}};
  await assert.rejects(controller.apply('a',condition(controller,false,'low'),-32,'dx1'),/readback|match|changed/);
  assert.equal(device.sent.some(f=>f.type===32&&f.command===0x7500),false);await controller.close();
});

test('an attenuation echo without applied volume prevents gain and PEQ writes',async()=>{
  const {device,controller}=await connect();
  device.hook=f=>{if(f.type===32&&f.command===0x810a){device.emit(f);return false;}};
  await assert.rejects(controller.apply('a',condition(controller,false,'low'),-32,'dx1'));
  assert.equal(device.output[2],910);
  assert.equal(device.sent.filter(f=>f.type===32).length,1);
  await controller.close();
});

test('an incoming gain event invalidates a completed PEQ comparison',async()=>{
  const {device,controller}=await connect();
  await controller.apply('a',condition(controller,false,'low'),-18,'dx1');
  device.emit({command:0x7500,value:1});
  assert.equal(controller.applied,null);
  await controller.close();
});

test('concurrent switches are rejected; preset changes, muted and non-HP routes fail before writes',async()=>{
  const {device,controller}=await connect();
  const operation=controller.apply('a',condition(controller),-18,'dx1');
  await assert.rejects(controller.apply('b',condition(controller),-18,'dx1'),/progress/); await operation; await controller.close();
  for(const modify of [d=>d.emit({command:0x9c01,value:0x2000000}),d=>d.output[6]=1,d=>d.output[1]=131]){
    const {device,controller}=await connect();modify(device);
    await assert.rejects(controller.apply('a',condition(controller),-18,'dx1'));
    assert.equal(device.sent.filter(f=>f.type===32).length,0);await controller.close();
  }
});

test('external route change after attenuation prevents all further writes',async()=>{
  const {device,controller}=await connect();
  device.hook=f=>{if(f.type===32&&f.command===0x810a){device.emit({command:0x810a,count:12,index:2,value:131});}};
  await assert.rejects(controller.apply('a',condition(controller,false,'low'),-32,'dx1'),/changed/);
  assert.equal(device.sent.filter(f=>f.type===32).length,1); await controller.close();
});

test('transport timeout poisons session and rejects delayed write resolution',async()=>{
  const device=new Device(),transport=new Dx1Transport(device,{timeoutMs:10}); await transport.open();
  device.sendReport=()=>new Promise(()=>{});
  await assert.rejects(transport.read('firmware'),/timed out/);
  await assert.rejects(transport.write(buildControlWrite('peq',false)),/timed out/); await transport.close();
});

test('batched reads correlate interleaved replies and block a simultaneous write',async()=>{
  const device=new Device(),transport=new Dx1Transport(device,{timeoutMs:50});await transport.open();
  const requests=[];device.sendReport=async(id,bytes)=>{requests.push(parseFrame(bytes));};
  const pending=transport.readMany(['preset','peq',{key:'nextOutput',count:12}]);
  await assert.rejects(transport.write(buildControlWrite('peq',false)),/already in progress/);
  // Allow the serialized USB sends to finish; responses can arrive in any command order.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,3);
  device.emit({command:0x1204,value:7});
  device.output.forEach((value,index)=>device.emit({command:0x810a,count:12,index:index+1,value}));
  device.emit({command:0x1206,value:1});
  const reads=await pending;assert.equal(reads.nextOutput.length,12);assert.equal(reads.preset[0].value,1);
  await transport.close();
});

test('Next 0x21 output snapshot acknowledges writes but does not satisfy an explicit read',async()=>{
  const {device,controller}=await connect();
  device.hook=f=>{
    if(f.type===32&&f.command===0x810a){
      device.output[f.index-1]=f.value;
      device.output.forEach((value,index)=>device.emit({type:0x21,command:f.command,count:12,index:index+1,value}));
      return false;
    }

  };
  await controller.apply('a',condition(controller),-18,'dx1');
  assert.equal(controller.state.volumeDb,-18);assert.equal(controller.state.peq,false);
  await controller.close();
});

 test('write-only 0x21 replies cannot complete a read request',async()=>{
  const device=new Device(),transport=new Dx1Transport(device,{timeoutMs:20});await transport.open();
  device.hook=f=>{device.emit({...f,type:0x21,value:0});return false;};
  await assert.rejects(transport.read('peq'),/timed out/);await transport.close();
});

 test('production PEQ controller never issues a gain read',async()=>{
  const device=new Device(),transport=new Dx1Transport(device),controller=new Dx1Controller(transport);
  await controller.connect();
  await controller.apply('a',condition(controller),-18,'dx1');
  await controller.apply('b',condition(controller,true),-8,'dx1');
  assert.equal(device.sent.some(frame=>frame.command===0x7500),false);
  assert.throws(()=>buildReadRequest(0x7500),/approved/);
  assert.throws(()=>buildControlWrite('gain','low'),/Unsupported/);
  assert.throws(()=>buildControlWrite('gain','high'),/Unsupported/);
  await controller.close();
});

for (const gain of [0,1]) for (const phase of ['idle','preflight','attenuation']) {
  test(`gain event ${gain} during ${phase} stops the session and further writes`,async()=>{
    const {device,controller}=await connect();
    if (phase==='idle') device.emit({command:0x7500,value:gain});
    else device.hook=f=>{
      if ((phase==='preflight'&&f.command===0x7100)
          ||(phase==='attenuation'&&f.type===32&&f.command===0x810a)) {
        device.emit({command:0x7500,value:gain});
      }
    };
    await assert.rejects(controller.apply('a',condition(controller),-18,'dx1'),/gain activity/);
    assert.equal(device.sent.filter(f=>f.type===32).length,phase==='attenuation'?1:0);
    const count=device.sent.length;
    await assert.rejects(controller.apply('a',condition(controller),-18,'dx1'),/gain activity/);
    assert.equal(device.sent.length,count);
    await controller.close();
  });
}

test('final snapshot rejects a changed preset even without a volume restoration',async()=>{
  const {device,controller}=await connect();
  device.hook=f=>{if(f.type===32&&f.command===0x110e) device.values.set(0x1206,2);};
  await assert.rejects(controller.apply('a',condition(controller),-32,'dx1'),/Preset changed|settings changed/);
  assert.equal(controller.applied,null);await controller.close();
});
