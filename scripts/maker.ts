import dotenv from "dotenv";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { sha3_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "@mysten/sui/transactions";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

dotenv.config();

const SUI_RPC = (process.env.SUI_RPC || process.env.SUI_RPC_URL) as string;
const SUI_KEYPAIR = process.env.SUI_KEYPAIR as string; // JSON array of 32 bytes
const FUSION_LOCKER_PACKAGE =
  process.env.FUSION_LOCKER_PACKAGE ||
  "0xfc2cd9bf4cc4135ec27dbf8e12f9ec37690c95f47a98b5406feb09aa060bcaf8";
const RESOLVER_ETH_ADDRESS = process.env.RESOLVER_ADDRESS as string;

if (!SUI_RPC || !SUI_KEYPAIR || !FUSION_LOCKER_PACKAGE) {
  console.error("Missing env: SUI_RPC, SUI_KEYPAIR, FUSION_LOCKER_PACKAGE");
  process.exit(1);
}

const provider = new SuiClient({ url: SUI_RPC });
const kp = Ed25519Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SUI_KEYPAIR))
);

async function makerLock() {
  const secret = randomBytes(32);
  const secretHex = "0x" + Buffer.from(secret).toString("hex");
  const secretHashSha3 = sha3_256(secret);
  const secretHashBlake = blake2b(secret, { dkLen: 32 });
  const secretHashKeccak = (await import("ethers")).ethers.id(secretHex);
  const secretHashVec = Array.from(secretHashBlake);
  console.log("BLAKE2b hash as vector:", secretHashVec);
  console.log("Generated secret:", secretHex);
  console.log("sha3_256(secret):", Buffer.from(secretHashSha3).toString("hex"));

  // Fetch first SUI coin large enough (≥ 1 SUI)
  const coins = await provider.getCoins({
    owner: kp.getPublicKey().toSuiAddress(),
  });
  if (coins.data.length === 0) {
    console.error("No SUI coins found for maker account");
    process.exit(1);
  }
  // Pick the largest coin object so we have enough gas budget
  const coin = coins.data.sort(
    (a: any, b: any) => Number(b.balance) - Number(a.balance)
  )[0];

  const durationMs = 60 * 60 * 1000; // 1 hour
  const tx = new Transaction();
  console.log("Using coin:", coin.coinObjectId, "balance:", coin.balance);
  console.log("Hash vector length:", secretHashVec.length);
  tx.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::shared_locker::maker_lock`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(coin.coinObjectId),
      tx.pure.vector("u8", secretHashVec),
      tx.pure.u64(durationMs),
      tx.pure.address(RESOLVER_ETH_ADDRESS || kp.getPublicKey().toSuiAddress()),
      tx.object("0x6"),
    ],
  });
  // Reduced gas budget to accommodate low balance accounts
  tx.setGasBudget(20_000_000);

  const result = await provider.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showObjectChanges: true },
  });

  console.log("Locker created. Digest:", result.digest);

  // Extract newly created locker object ID
  const createdLocker = result.objectChanges?.find(
    (c: any) =>
      (c.type === "created" ||
        c.type === "shared" ||
        c.type === "sharedObject") &&
      typeof c.objectType === "string" &&
      c.objectType.includes("shared_locker::SharedLocker")
  );
  const lockerId = (createdLocker as any)?.objectId as string | undefined;
  let finalLockerId = lockerId;
  if (!finalLockerId) {
    // retry loop for eventual consistency
    for (let i = 0; i < 10; i++) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const txb = await provider.getTransactionBlock({
          digest: result.digest,
          options: { showObjectChanges: true },
        });
        const maybe = txb.objectChanges?.find(
          (c: any) =>
            (c.type === "created" ||
              c.type === "shared" ||
              c.type === "sharedObject") &&
            typeof c.objectType === "string" &&
            c.objectType.includes("shared_locker::SharedLocker")
        );
        finalLockerId = (maybe as any)?.objectId;
        if (finalLockerId) {
          console.log(
            `✅ Found SharedLocker after ${i + 1} retries:`,
            finalLockerId
          );
          break;
        }
      } catch (_) {}
    }
  }
  if (!finalLockerId) {
    console.error(
      "❌ Could not find SharedLocker object ID even after 10 retries"
    );
    process.exit(1);
  }

  // Persist secret details for resolver & relayer
  const persistPath = path.resolve("./generatedSecret.json");
  fs.writeFileSync(
    persistPath,
    JSON.stringify(
      {
        secret: secretHex,
        hash_sha3: "0x" + Buffer.from(secretHashSha3).toString("hex"),
        hash_blake: "0x" + Buffer.from(secretHashBlake).toString("hex"),
        hash_keccak: secretHashKeccak,
        lockerId: finalLockerId,
        txDigest: result.digest,
      },
      null,
      2
    )
  );
  // Update secretMapping.json for relayer
  const mappingPath = path.resolve("./secretMapping.json");
  let mapping: any = {};
  if (fs.existsSync(mappingPath)) {
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  }
  mapping[secretHashKeccak] = { lockerId: finalLockerId };
  const secretBlakeHex = "0x" + Buffer.from(secretHashBlake).toString("hex");
  mapping[secretBlakeHex] = { lockerId: finalLockerId };
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log("Mapping updated at", mappingPath);

  console.log("Secret stored to", persistPath);
}

makerLock().catch((e) => {
  console.error(e);
  process.exit(1);
});
