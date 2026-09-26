// End-to-end fixture run for levarac/mizar#8.
//
// Starts a local anvil chain (chain id 11155111 to match the evaluation
// parameters), deploys a MockEAS from a separate account, then deploys
// MizarClaim as anvil account 0's first transaction so it lands at the
// golden-vector address 0x5FbDB2315678afecb367f032d93F642f64180aa3.
// Runs the real evaluator (evaluator/, `pnpm mizar evaluate`) on the fixture
// inputs, posts the resulting root, and claims for one eligible event key
// with a purpose 0x02 signature made with that key's deterministic test key.
// The golden vector's event key is not in the evaluator's eligible set, so it
// is asserted separately as a codec check: digest and signature byte for byte.
//
// Usage: pnpm e2e   (override the anvil port with E2E_ANVIL_PORT)

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  SigningKey,
  Wallet,
  ZeroAddress,
  keccak256,
} from 'ethers';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(e2eDir, '..');
const contractsDir = join(repoRoot, 'contracts');
const evaluatorDir = join(repoRoot, 'evaluator');

const CHAIN_ID = 11155111n; // must match evaluator/test/fixtures/params.json
const RPC_URL = (port) => `http://127.0.0.1:${port}`;

// Anvil's default mnemonic accounts; these are public test keys, not secrets.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // account 0 -> 0xf39F...2266, first deployment lands at the golden claimContract
const EAS_DEPLOYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // account 2
const POSTER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // account 3
const SUBMITTER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'; // account 4, claims can be submitted by any wallet
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil account 1, the claimant's wallet

const vector = JSON.parse(
  readFileSync(join(repoRoot, 'docs/design/test-vectors/app-signature-v1.json'), 'utf8'),
);
const params = JSON.parse(
  readFileSync(join(evaluatorDir, 'test/fixtures/params.json'), 'utf8'),
);

// Deterministic fixture event keys, per evaluator/test/fixtures/generate.ts:
// private key = SHA256("Mizar public deterministic TEST KEY: " + label).
const TEST_KEY_LABELS = ['A', 'B', 'C', 'M1', 'M2', 'M3', 'D'];
const testKey = (label) =>
  `0x${createHash('sha256').update(`Mizar public deterministic TEST KEY: ${label}`).digest('hex')}`;

const SCHEMA_UID = keccak256(
  AbiCoder.defaultAbiCoder().encode(
    ['string', 'address', 'bool'],
    ['bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest', ZeroAddress, false],
  ),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fromHex = (value) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const uint256be = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

// spec.md: M = 0xFF || "beid/event-key-sign/v1" || 0x00 || purpose || eventId || body,
// digest = SHA256(M). Purpose 0x02 body = chainId(uint256) || claimContract || recipient.
function claimDigest(eventId, chainId, claimContract, recipient) {
  const body = Buffer.concat([uint256be(chainId), fromHex(claimContract), fromHex(recipient)]);
  return createHash('sha256').update(Buffer.concat([
    Buffer.from([0xff]), Buffer.from('beid/event-key-sign/v1'), Buffer.from([0x00, 0x02]),
    fromHex(eventId), body,
  ])).digest();
}

async function freePort() {
  if (process.env.E2E_ANVIL_PORT) return Number(process.env.E2E_ANVIL_PORT);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Assert the call reverts: eth_call decodes the custom error, then a broadcast
// confirms it also reverts when mined. The nonce is tracked locally because
// anvil's eth_getTransactionCount can lag one mined block behind.
async function expectRevert(contract, functionName, args, errorName, sender, nonce) {
  let callError;
  try {
    await contract[functionName].staticCall(...args);
  } catch (e) {
    callError = e;
  }
  assert.ok(callError, `expected ${functionName} to revert with ${errorName}, staticCall succeeded`);
  const decoded = callError?.revert?.name ?? callError?.info?.error?.name ?? '';
  const text = `${callError?.shortMessage ?? ''} ${callError?.message ?? ''} ${decoded}`;
  assert.ok(
    decoded === errorName || text.includes(errorName),
    `expected revert ${errorName}, got ${decoded || callError?.code || callError}`,
  );
  const data = contract.interface.encodeFunctionData(functionName, args);
  const tx = await sender.sendTransaction({
    to: await contract.getAddress(),
    data,
    gasLimit: 500_000,
    nonce,
  });
  const receipt = await tx.wait().catch(() => null);
  assert.ok(!receipt || receipt.status === 0, `expected ${errorName} but the transaction succeeded`);
  return nonce + 1;
}

async function main() {
  console.log('building contracts/ artifacts with forge build');
  execFileSync('forge', ['build'], { cwd: contractsDir, stdio: 'inherit' });

  const mizarArtifact = JSON.parse(
    readFileSync(join(contractsDir, 'out/MizarClaim.sol/MizarClaim.json'), 'utf8'),
  );
  const mockEasArtifact = JSON.parse(
    readFileSync(join(contractsDir, 'out/MizarClaim.t.sol/MockEAS.json'), 'utf8'),
  );

  console.log('installing evaluator dependencies');
  execFileSync('pnpm', ['--dir', evaluatorDir, 'install'], { stdio: 'inherit' });

  const outDir = mkdtempSync(join(tmpdir(), 'mizar-e2e-eval-'));
  const evaluateOut = execFileSync(
    'pnpm',
    ['--dir', evaluatorDir, 'mizar', 'evaluate', '--params', 'test/fixtures/params.json', '--out', outDir],
    { encoding: 'utf8' },
  ).trim();
  const evaluated = JSON.parse(evaluateOut.split('\n').filter((l) => l.startsWith('{')).pop());
  assert.equal(evaluated.result, 'EVALUATED', `mizar evaluate returned ${evaluateOut}`);

  const manifestBytes = readFileSync(join(outDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString());
  const manifestDigest = `0x${createHash('sha256').update(manifestBytes).digest('hex')}`;
  const root = manifest.root;
  const snapshotId = BigInt(manifest.parameters.snapshot.id);
  const cutoffBlock = BigInt(manifest.parameters.snapshot.cutoffBlock);
  const eventId = manifest.parameters.eventId;
  assert.equal(eventId, params.eventId, 'manifest eventId mismatch');
  assert.equal(BigInt(manifest.parameters.chainId), CHAIN_ID, 'manifest chainId mismatch');
  console.log(`evaluator root ${root} (snapshot ${snapshotId}, cutoff ${cutoffBlock})`);

  const eligible = JSON.parse(readFileSync(join(outDir, 'eligible.json'), 'utf8'));
  const claimants = TEST_KEY_LABELS
    .map((label) => ({ label, key: testKey(label), address: new Wallet(testKey(label)).address }))
    .find(({ address }) => eligible.addresses.some((a) => a.toLowerCase() === address.toLowerCase()));
  assert.ok(claimants, 'no deterministic test key found in the evaluator eligible set');
  const proofFile = JSON.parse(
    readFileSync(join(outDir, 'proofs', `${claimants.address.toLowerCase()}.json`), 'utf8'),
  );
  assert.equal(proofFile.root.toLowerCase(), root.toLowerCase(), 'proof root mismatch');
  console.log(`claiming for fixture key "${claimants.label}" (${claimants.address})`);

  const port = await freePort();
  const anvil = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  anvil.stdout.resume();
  let anvilExit = null;
  anvil.on('exit', (code, signal) => { anvilExit = code ?? signal; });

  let provider;
  try {
    provider = new JsonRpcProvider(RPC_URL(port), Number(CHAIN_ID), { staticNetwork: true });
    for (let i = 0; ; i++) {
      if (anvilExit !== null) throw new Error(`anvil exited early (${anvilExit})`);
      try {
        await provider.getBlockNumber();
        break;
      } catch (e) {
        if (i >= 100) throw new Error(`anvil did not start on ${RPC_URL(port)}: ${e}`);
        await sleep(100);
      }
    }
    assert.equal(
      BigInt(await provider.send('eth_chainId', [])),
      CHAIN_ID,
      'anvil must run the evaluation-parameters chain id',
    );

    // mizar verify reads RootPosted from cutoffBlock onward, so the local chain
    // must be past the fixture's cutoff block before the root is posted.
    const head = BigInt(await provider.getBlockNumber());
    if (head <= cutoffBlock) {
      await provider.send('anvil_mine', [`0x${(cutoffBlock - head + 5n).toString(16)}`]);
    }

    const deployer = new Wallet(DEPLOYER_KEY, provider);
    const easDeployer = new Wallet(EAS_DEPLOYER_KEY, provider);
    const poster = new Wallet(POSTER_KEY, provider);
    const submitter = new Wallet(SUBMITTER_KEY, provider);

    assert.equal(
      await provider.getTransactionCount(deployer.address),
      0,
      'deployer must be unused so MizarClaim lands at the golden-vector address',
    );

    const mockEas = await new ContractFactory(
      mockEasArtifact.abi,
      mockEasArtifact.bytecode.object,
      easDeployer,
    ).deploy();
    await mockEas.waitForDeployment();
    const easAddress = await mockEas.getAddress();
    console.log(`MockEAS deployed at ${easAddress}`);

    const claimDeploy = await new ContractFactory(
      mizarArtifact.abi,
      mizarArtifact.bytecode.object,
      deployer,
    ).deploy(easAddress, SCHEMA_UID, eventId, poster.address);
    await claimDeploy.waitForDeployment();
    const claimAddress = await claimDeploy.getAddress();
    assert.equal(
      claimAddress,
      vector.claim.claimContract,
      'MizarClaim must be deployed at the golden-vector address',
    );
    console.log(`MizarClaim deployed at ${claimAddress}`);

    const claimAsPoster = new Contract(claimAddress, mizarArtifact.abi, poster);
    const postReceipt = await (
      await claimAsPoster.postRoot(snapshotId, root, manifestDigest, cutoffBlock)
    ).wait();
    const rootPosted = postReceipt.logs
      .map((l) => {
        try { return claimAsPoster.interface.parseLog(l); } catch { return null; }
      })
      .find((e) => e?.name === 'RootPosted');
    assert.ok(rootPosted, 'RootPosted event not emitted');
    assert.equal(rootPosted.args.root, root);
    assert.equal(rootPosted.args.manifestDigest, manifestDigest);
    assert.equal(rootPosted.args.cutoffBlock, cutoffBlock);
    console.log(`root ${root} posted for snapshot ${snapshotId}`);

    const digest = claimDigest(eventId, CHAIN_ID, claimAddress, RECIPIENT);
    const appSignature = new SigningKey(claimants.key).sign(`0x${digest.toString('hex')}`).serialized;

    const claimAsSubmitter = new Contract(claimAddress, mizarArtifact.abi, submitter);
    const uid = await claimAsSubmitter.claim.staticCall(
      snapshotId, claimants.address, proofFile.proof, RECIPIENT, appSignature,
    );
    const claimTx = await claimAsSubmitter.claim(
      snapshotId, claimants.address, proofFile.proof, RECIPIENT, appSignature,
    );
    let submitterNonce = claimTx.nonce + 1;
    const claimReceipt = await claimTx.wait();
    const claimed = claimReceipt.logs
      .map((l) => {
        try { return claimAsSubmitter.interface.parseLog(l); } catch { return null; }
      })
      .find((e) => e?.name === 'Claimed');
    assert.ok(claimed, 'Claimed event not emitted');
    assert.equal(claimed.args.eventKeyAddress, claimants.address);
    assert.equal(claimed.args.recipient, RECIPIENT);
    assert.equal(claimed.args.snapshotId, snapshotId);
    assert.equal(claimed.args.uid, uid);

    const eas = new Contract(easAddress, mockEasArtifact.abi, provider);
    const expectedData = AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint64', 'bytes32'],
      [eventId, claimants.address, snapshotId, manifestDigest],
    );
    assert.equal(await eas.calls(), 1n, 'exactly one attestation expected');
    assert.equal(await eas.uid(), uid, 'attestation uid mismatch');
    assert.equal(await eas.schema(), SCHEMA_UID);
    assert.equal(await eas.recipient(), RECIPIENT);
    assert.equal(await eas.data(), expectedData, 'attestation data mismatch');
    assert.equal(await eas.revocable(), false);
    assert.equal(await eas.expirationTime(), 0n);
    assert.equal(await eas.refUID(), `0x${'0'.repeat(64)}`);
    assert.equal(await eas.value(), 0n);
    console.log('PASS: attestation issued to the recipient with the expected data');

    submitterNonce = await expectRevert(
      claimAsSubmitter, 'claim',
      [snapshotId, claimants.address, proofFile.proof, RECIPIENT, appSignature],
      'AlreadyClaimed', submitter, submitterNonce,
    );
    assert.equal(await eas.calls(), 1n, 'a second claim must not attest again');
    console.log('PASS: second claim for the same event key reverted with AlreadyClaimed');

    const otherRecipient = '0x000000000000000000000000000000000000dEaD';
    await expectRevert(
      claimAsSubmitter, 'claim',
      [snapshotId, claimants.address, proofFile.proof, otherRecipient, appSignature],
      'InvalidSigner', submitter, submitterNonce,
    );
    console.log('PASS: claim with a different recipient reverted with InvalidSigner');

    // Codec check: the golden vector's key is not in the evaluator's eligible
    // set, so its claim signature is verified byte for byte off-chain instead.
    const goldenDigest = claimDigest(
      vector.eventId, BigInt(vector.claim.chainId), vector.claim.claimContract, vector.claim.recipient,
    );
    assert.equal(`0x${goldenDigest.toString('hex')}`, vector.claim.digest, 'golden digest mismatch');
    const goldenSignature = new SigningKey(vector.testPrivateKey)
      .sign(`0x${goldenDigest.toString('hex')}`).serialized;
    assert.equal(goldenSignature, vector.claim.signature, 'golden signature mismatch');
    assert.equal(new Wallet(vector.testPrivateKey).address, vector.eventKeyAddress,
      'golden key address mismatch');
    console.log('PASS: signing codec reproduces the golden vector digest and signature byte for byte');

    const verifyOut = execFileSync(
      'pnpm',
      ['--dir', evaluatorDir, 'mizar', 'verify', '--manifest', join(outDir, 'manifest.json'),
        '--rpc', RPC_URL(port), '--contract', claimAddress],
      { encoding: 'utf8' },
    ).trim();
    const receipt = JSON.parse(verifyOut.split('\n').filter((l) => l.startsWith('{')).pop());
    assert.equal(receipt.result, 'PASS', `mizar verify returned ${verifyOut}`);
    console.log('PASS: mizar verify --rpc --contract returned {"result":"PASS"}');

    console.log('e2e fixture run complete');
  } finally {
    provider?.destroy();
    anvil.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
