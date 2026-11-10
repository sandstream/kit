import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

/** A separate fixture authority signs statements and retains its current checkpoint. */
export async function externalAuditFixture(
  t: TestContext,
): Promise<
  ReturnType<typeof auditFixture> & { witness: string; indexPath: string; logPath: string }
> {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);`,
    ),
  ]);
  const witness = join(fixture.root, "witness");
  mkdirSync(witness);
  const keys = generateKeyPairSync("ed25519");
  writeFileSync(
    join(witness, "private.pem"),
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(witness, "public.pem"),
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const client = join(witness, "client.mjs");
  writeFileSync(
    client,
    `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash,sign,verify} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const request=JSON.parse(readFileSync(0,'utf8'));
const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const statement=request.statement;
if(request.version!==1 || statement.domain!=='kit.audit.external/v1' || statement.version!==1) throw Error('unsupported statement');
if(!Number.isSafeInteger(statement.count) || statement.count<1 || typeof statement.logPath!=='string') throw Error('invalid statement');
const headPath=join(root,'heads.json');
const heads=existsSync(headPath)?JSON.parse(readFileSync(headPath,'utf8')):{};
if(request.operation==='anchor') {
 const payload={statement,authority:'fixture-authority',timestamp:'2026-01-01T00:00:00.000Z'};
 const signature=sign(null,Buffer.from(JSON.stringify(payload)),readFileSync(join(root,'private.pem'))).toString('base64');
 const token=Buffer.from(JSON.stringify({payload,signature})).toString('base64');
 heads[statement.logPath]=digest(statement);
 writeFileSync(headPath,JSON.stringify(heads));
 process.stdout.write(JSON.stringify({token,authority:payload.authority,timestamp:payload.timestamp}));
} else if(request.operation==='verify') {
 const envelope=JSON.parse(Buffer.from(request.receipt.token,'base64').toString('utf8'));
 const payload=envelope.payload;
 const valid=verify(null,Buffer.from(JSON.stringify(payload)),readFileSync(join(root,'public.pem')),Buffer.from(envelope.signature,'base64'));
 const bound=JSON.stringify(payload.statement)===JSON.stringify(statement);
 const authenticity=valid && bound ? 'valid':'invalid';
 const rollback=!(statement.logPath in heads)?'unknown':heads[statement.logPath]===digest(statement)?'acceptable':'stale';
 process.stdout.write(JSON.stringify({version:1,requestId:request.requestId,statementDigest:digest(statement),receiptDigest:digest(request.receipt),authenticity,rollback,authority:payload.authority,attestedAt:payload.timestamp}));
} else throw Error('invalid operation');
`,
  );
  // These paths contain no shell metacharacters except spaces, which stay quoted.
  const command = `"${process.execPath}" "${client}"`;
  fixture.env.KIT_EXTERNAL_ANCHOR_CMD = command;
  fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD = command;
  const indexPath = join(fixture.home, "anchors", "audit-anchor.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const logPath = Object.keys(index)[0];
  assert.ok(logPath);
  return { ...fixture, witness, indexPath, logPath };
}

export function externalEvidence(fixture: Awaited<ReturnType<typeof externalAuditFixture>>) {
  return {
    log: readFileSync(fixture.logPath),
    index: readFileSync(fixture.indexPath),
    key: readFileSync(join(fixture.home, "anchors", "audit-anchor.key")),
    checkpoint: existsSync(join(fixture.witness, "heads.json"))
      ? readFileSync(join(fixture.witness, "heads.json"))
      : null,
  };
}
