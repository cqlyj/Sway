import dotenv from "dotenv";
import fs from "fs";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

// Loads .env from repo root even when script executed from nested workspace
import path from "path";
// Load .env from repo root regardless of workspace cwd
dotenv.config({
  path: path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../..",
    ".env"
  ),
});

const {
  SUI_RPC,
  SUI_KEYPAIR,
  FUSION_LOCKER_PACKAGE,
  SUI_ADDRESS,
  SECRET_FILE = "./generatedSecret.json",
} = process.env as Record<string, string>;

if (!SUI_RPC || !SUI_KEYPAIR || !FUSION_LOCKER_PACKAGE) {
  console.error(
    "Missing SUI_RPC, SUI_KEYPAIR or FUSION_LOCKER_PACKAGE env var"
  );
  process.exit(1);
}

if (!fs.existsSync(SECRET_FILE)) {
  console.error(`Secret file ${SECRET_FILE} not found`);
  process.exit(1);
}

interface SecretJson {
  secret: string; // 0x...
  hash_sha3: string;
  hash_keccak: string;
}

const secretInfo: SecretJson = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
const secretHex = secretInfo.secret;
const secretBytes = Uint8Array.from(Buffer.from(secretHex.slice(2), "hex"));
const hashBlake =
  "0x" + Buffer.from(blake2b(secretBytes, { dkLen: 32 })).toString("hex");

(async () => {
  const provider = new SuiClient({ url: SUI_RPC });
  const kp = Ed25519Keypair.fromSecretKey(
    (() => {
      const arr = JSON.parse(SUI_KEYPAIR as string);
      return Uint8Array.from(arr.length === 33 ? arr.slice(1) : arr);
    })()
  );
  const resolverAddr = kp.getPublicKey().toSuiAddress();
  console.log("Resolver Sui address:", resolverAddr);

  // Does a locker already exist for this resolver?
  async function findLocker() {
    const objs = await provider.getOwnedObjects({ owner: resolverAddr });
    for (const o of objs.data) {
      const t = (o as any).data?.type as string | undefined;
      if (t && t.includes("::locker::Locker<"))
        return (o as any).data?.objectId as string;
    }
    return undefined;
  }

  let lockerId = await findLocker();
  if (!lockerId) {
    // 1. pick first coin >= 0.01 SUI
    const coins = await provider.getCoins({ owner: resolverAddr });
    if (!coins.data.length) {
      console.error("Resolver account has no SUI coin objects – top up first");
      process.exit(1);
    }
    const coin = coins.data[0];

    // 2. build tx: lock
    const durationMs = 60 * 60 * 1000; // 1h
    const txLock = new Transaction();
    txLock.moveCall({
      target: `${FUSION_LOCKER_PACKAGE}::locker::lock`,
      typeArguments: ["0x2::sui::SUI"],
      arguments: [
        txLock.object(coin.coinObjectId),
        txLock.pure(Uint8Array.from(Buffer.from(hashBlake.slice(2), "hex"))),
        txLock.pure.u64(durationMs),
        txLock.pure.address(resolverAddr),
        txLock.object("0x6"),
      ],
    });
    txLock.setGasBudget(40_000_000);

    const resLock = await provider.signAndExecuteTransaction({
      signer: kp,
      transaction: txLock,
      options: { showEffects: true, showObjectChanges: true },
    });
    const effectsCreated = (resLock as any).effects?.created;
    if (effectsCreated && effectsCreated.length) {
      lockerId = effectsCreated[0].reference.objectId as string;
      console.log("Locker object id:", lockerId);
    }
    console.log("Locker created. Digest:", resLock.digest);

    // find locker id if not captured from effects
    const createdLocker =
      !lockerId &&
      ((resLock.objectChanges || []).find(
        (c: any) =>
          c.type === "created" &&
          typeof c.objectType === "string" &&
          c.objectType.includes("::locker::Locker<")
      ) as any);
    if (!createdLocker) {
      console.warn("Locker object not found in tx result; fetching via RPC …");
      const txInfo = await provider.getTransactionBlock({
        digest: resLock.digest,
        options: { showObjectChanges: true },
      });
      const created = (txInfo.objectChanges || []).find(
        (c: any) =>
          c.type === "created" &&
          typeof c.objectType === "string" &&
          c.objectType.includes("::locker::Locker<")
      );
      if (created) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        lockerId = (created as any).objectId as string;
      } else {
        // fallback after delay
        await new Promise((r) => setTimeout(r, 4000));
        lockerId = await findLocker();
      }
      if (!lockerId) {
        console.error("Unable to locate Locker after creation");
        process.exit(1);
      }
    } else {
      lockerId = createdLocker.objectId as string;
      console.log("Locker object id:", lockerId);
    }
  } else {
    console.log("Found existing locker:", lockerId);
  }

  // Persist mapping for relayer: secretHashBlake -> lockerId
  try {
    const mappingPath = path.resolve("./secretMapping.json");
    let mapping: any = {};
    if (fs.existsSync(mappingPath)) {
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
    }
    mapping[hashBlake] = { lockerId };
    fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
    console.log("Mapping updated at", mappingPath);
  } catch (err) {
    console.warn("Failed to persist secret mapping", err);
  }

  // 3. claim immediately (reveal secret, transfer SUI to maker Sui address)
  const txClaim = new Transaction();
  txClaim.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::locker::claim`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      txClaim.object(lockerId),
      txClaim.pure(secretBytes),
      txClaim.pure.address(SUI_ADDRESS || resolverAddr),
      txClaim.object("0x6"),
    ],
  });
  txClaim.setGasBudget(20_000_000);
  const resClaim = await provider.signAndExecuteTransaction({
    signer: kp,
    transaction: txClaim,
  });
  console.log("✅ Secret revealed on Sui. Claim digest:", resClaim.digest);
})();
