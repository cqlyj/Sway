import dotenv from "dotenv";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import fs from "fs";

dotenv.config();

const SUI_RPC = process.env.SUI_RPC as string;
const SUI_KEYPAIR = process.env.SUI_KEYPAIR as string;
const FUSION_LOCKER_PACKAGE = process.env.FUSION_LOCKER_PACKAGE as string;

async function main() {
  // Read the generated secret
  const secretInfo = JSON.parse(
    fs.readFileSync("./generatedSecret.json", "utf8")
  );
  const secret = secretInfo.secret;
  const secretBytes = Uint8Array.from(Buffer.from(secret.slice(2), "hex"));

  console.log("Testing secret reveal with secret:", secret);

  const provider = new SuiClient({ url: SUI_RPC });
  const kp = Ed25519Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(SUI_KEYPAIR))
  );

  // Use the known SharedLocker ID from the mapping
  const mapping = JSON.parse(fs.readFileSync("./secretMapping.json", "utf8"));
  const secretHashKeccak = secretInfo.hash_keccak;
  const lockerId = mapping[secretHashKeccak]?.lockerId;

  if (!lockerId) {
    console.error(
      "No SharedLocker ID found in mapping for hash:",
      secretHashKeccak
    );
    return;
  }

  console.log("Using SharedLocker ID:", lockerId);

  // Try to claim with the secret
  const tx = new Transaction();
  tx.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::shared_locker::claim_shared`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(lockerId),
      tx.pure.vector("u8", Array.from(secretBytes)),
      tx.pure.address(kp.getPublicKey().toSuiAddress()),
      tx.object("0x6"),
    ],
  });
  tx.setGasBudget(20_000_000);

  try {
    const result = await provider.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
      options: { showEvents: true },
    });

    console.log("✅ Secret revealed! Digest:", result.digest);
    console.log("Events:", result.events);
  } catch (error) {
    console.error("Failed to reveal secret:", error);
  }
}

main().catch(console.error);
